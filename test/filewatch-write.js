var fs = require('fs');

var filename = 'test.txt';
var writeIndex = 0;

function pad(n, width, z) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function log(msg) {
	var d = new Date();
	console.log("["+pad(d.getHours(), 2)+":"+pad(d.getMinutes(), 2)+":"+pad(d.getSeconds(), 2)+"."+pad(d.getMilliseconds(), 3)+"] "+msg);
}

function writeOneChar() {
	if (writeIndex < 200 ) {
		var timeout;
		if (writeIndex < 10) timeout = 1000;
		else if (writeIndex < 100) timeout = 100;
		else timeout = 10;
		log("writing to file");
		fs.writeSync(file, String.fromCharCode(Math.floor(Math.random()*100)));
		writeIndex++;
		setTimeout(writeOneChar, timeout);	
	} else {
		fs.closeSync(file);
		log("Closing file");		
	}
}

var file = fs.openSync(filename, "w");
log("Opening file");
writeOneChar();

