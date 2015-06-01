var fs = require('fs');

var filename = 'test.txt';

function pad(n, width, z) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function log(msg) {
	var d = new Date();
	console.log("["+pad(d.getHours(), 2)+":"+pad(d.getMinutes(), 2)+":"+pad(d.getSeconds(), 2)+"."+pad(d.getMilliseconds(), 3)+"] "+msg);
}

function fileListener(event, filename) {
	log("Event "+event);
}

fs.watch(filename, fileListener);
