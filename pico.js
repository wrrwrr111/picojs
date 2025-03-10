/* This library is released under the MIT license, see https://github.com/tehnokv/picojs */
pico = {}

pico.unpack_cascade = function(bytes)
{
	//
	var dview = new DataView(new ArrayBuffer(4));
	/*
		we skip the first 8 bytes of the cascade file
		(cascade version number and some data used during the learning process)
	*/
	var p = 8;
	/*
		read the depth (size) of each tree first: a 32-bit signed integer
	*/
	dview.setUint8(0, bytes[p+0]), dview.setUint8(1, bytes[p+1]), dview.setUint8(2, bytes[p+2]), dview.setUint8(3, bytes[p+3]);
	var tdepth = dview.getInt32(0, true);
	p = p + 4
	/*
		next, read the number of trees in the cascade: another 32-bit signed integer
	*/
	dview.setUint8(0, bytes[p+0]), dview.setUint8(1, bytes[p+1]), dview.setUint8(2, bytes[p+2]), dview.setUint8(3, bytes[p+3]);
	var ntrees = dview.getInt32(0, true);
	p = p + 4
	/*
		read the actual trees and cascade thresholds
	*/
	var tcodes = [];
	var tpreds = [];
	var thresh = [];
	for(var t=0; t<ntrees; ++t)
	{
		var i;
		// read the binary tests placed in internal tree nodes
		Array.prototype.push.apply(tcodes, [0, 0, 0, 0]);
		Array.prototype.push.apply(tcodes, bytes.slice(p, p+4*Math.pow(2, tdepth)-4));
		p = p + 4*Math.pow(2, tdepth)-4;
		// read the prediction in the leaf nodes of the tree
		for(i=0; i<Math.pow(2, tdepth); ++i)
		{
			dview.setUint8(0, bytes[p+0]), dview.setUint8(1, bytes[p+1]), dview.setUint8(2, bytes[p+2]), dview.setUint8(3, bytes[p+3]);
			tpreds.push(dview.getFloat32(0, true));
			p = p + 4;
		}
		// read the threshold
		dview.setUint8(0, bytes[p+0]), dview.setUint8(1, bytes[p+1]), dview.setUint8(2, bytes[p+2]), dview.setUint8(3, bytes[p+3]);
		thresh.push(dview.getFloat32(0, true));
		p = p + 4;
	}
	tcodes = new Int8Array(tcodes)
	tpreds = new Float32Array(tpreds)
	thresh = new Float32Array(thresh)
	/*
		construct the classification function from the read data
	*/
	function classify_region(r, c, s, pixels, ldim)
	{
		 r = 256*r;
		 c = 256*c;
		 var root = 0;
		 var o = 0.0;
		 var pow2tdepth = Math.pow(2, tdepth) >> 0; // '>>0' transforms this number to int

		 for(var i=0; i<ntrees; ++i)
		 {
			idx = 1;
			for(var j=0; j<tdepth; ++j)
				// we use '>> 8' here to perform an integer division: this seems important for performance
				idx = 2*idx + (pixels[((r+tcodes[root + 4*idx + 0]*s) >> 8)*ldim+((c+tcodes[root + 4*idx + 1]*s) >> 8)]<=pixels[((r+tcodes[root + 4*idx + 2]*s) >> 8)*ldim+((c+tcodes[root + 4*idx + 3]*s) >> 8)]);

			 o = o + tpreds[pow2tdepth*i + idx-pow2tdepth];

			 if(o<=thresh[i])
				 return -1;

			 root += 4*pow2tdepth;
		}
		return o - thresh[ntrees-1];
	}
	/*
		we're done
	*/
	return classify_region;
}

pico.run_cascade = function(image, classify_region, params)
{
	var pixels = image.pixels;
	var nrows = image.nrows;
	var ncols = image.ncols;
	var ldim = image.ldim;

	var shiftfactor = params.shiftfactor;
	var minsize = params.minsize;
	var maxsize = params.maxsize;
	var scalefactor = params.scalefactor;

	var scale = minsize;
	var detections = [];

	while(scale<=maxsize)
	{
		var step = Math.max(shiftfactor*scale, 1) >> 0; // '>>0' transforms this number to int
		var offset = (scale/2 + 1) >> 0;

		for(var r=offset; r<=nrows-offset; r+=step)
			for(var c=offset; c<=ncols-offset; c+=step)
			{
				var q = classify_region(r, c, scale, pixels, ldim);
				if (q > 0.0)
					detections.push([r, c, scale, q]);
			}

		scale = scale*scalefactor;
	}

    return detections;
}

pico.cluster_detections = function(dets, iouthreshold)
{
	/*
		sort detections by their score
	*/
	dets = dets.sort(function(a, b) {
		return b[3] - a[3];
	})
	/*
		this helper function calculates the intersection over union for two detections
	*/
	function calculate_iou(det1, det2)
	{
		// unpack the position and size of each detection
		var r1=det1[0], c1=det1[1], s1=det1[2];
		var r2=det2[0], c2=det2[1], s2=det2[2];
		// calculate detection overlap in each dimension
		var overr = Math.max(0, Math.min(r1+s1/2, r2+s2/2) - Math.max(r1-s1/2, r2-s2/2));
		var overc = Math.max(0, Math.min(c1+s1/2, c2+s2/2) - Math.max(c1-s1/2, c2-s2/2));
		// calculate and return IoU
		return overr*overc/(s1*s1+s2*s2-overr*overc);
	}
	/*
		do clustering through non-maximum suppression
	*/
	var assignments = new Array(dets.length).fill(0);
	var clusters = [];
	for(var i=0; i<dets.length; ++i)
	{
		// is this detection assigned to a cluster?
		if(assignments[i]==0)
		{
			// it is not:
			// now we make a cluster out of it and see whether some other detections belong to it
			var r=0.0, c=0.0, s=0.0, q=0.0, n=0;
			for(var j=i; j<dets.length; ++j)
				if(calculate_iou(dets[i], dets[j])>iouthreshold)
				{
					assignments[j] = 1;
					r = r + dets[j][0];
					c = c + dets[j][1];
					s = s + dets[j][2];
					q = q + dets[j][3];
					n = n + 1;
				}
			// make a cluster representative
			clusters.push([r/n, c/n, s/n, q]);
		}
	}

	return clusters;
}

pico.instantiate_detection_memory = function(size)
{
	/*
		initialize a circular buffer of `size` elements
	*/
	var n = 0, memory = [];
	for(var i=0; i<size; ++i)
		memory.push([]);
	/*
		build a function that:
		(1) inserts the current frame's detections into the buffer;
		(2) merges all detections from the last `size` frames and returns them
	*/
	function update_memory(dets)
	{
		memory[n] = dets;
		n = (n+1)%memory.length;
		dets = [];
		for(i=0; i<memory.length; ++i)
			dets = dets.concat(memory[i]);
		//
		return dets;
	}
	/*
		we're done
	*/
	return update_memory;
}
