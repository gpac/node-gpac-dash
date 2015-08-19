/* 
 * Copyright (c) 2012-2013. Telecom ParisTech/TSI/MM/GPAC 
 * License: AGPL-3-Clause (see LICENSE file)
 *
 * NodeJS code to serve media content using DASH in low latency mode
 ******************************************************************************/

function usage() {
	console.log("node dash-chunked.js [options]");
	console.log("Basic options");
	console.log("-log <level>           sets the log level: info (default) | debug-basic | debug-max");
	console.log("-ip <IP>               IP address of the server (default 127.0.0.1)");
	console.log("-port <port>           port of the server (default 8000)");
	console.log("-chunk-media-segments  send media segments asap using chunked transfer (default no)");
	console.log("-segment-marker <4cc>  marker for end of segment (default eods)");
	console.log("-use-watchFile         uses watchFile API instead of watch");

	console.log();
}

var fs = require('fs');
var http = require('http');
var url_parser = require('url');

var ipaddr = "127.0.0.1";
var port = 8000;
var logLevel = 0;

/* Boolean controlling the sending of segments fragment-by-fragment as HTTP chunks, 
   requires MP4Box or DashCast to use -segment-marker eods */
var sendMediaSegmentsFragmented = false;
var SEGMENT_MARKER = "eods";
var sendInitSegmentsFragmented = false;

var use_watchFile = false;
var watchOptions = { persistent: true, recursive: false };
var watchFileOptions = { persistent: true, interval: 10 };

var logLevels = {
  INFO: 0,
  DEBUG_BASIC: 1,
  DEBUG_MAX: 2
};

function pad(n, width, z) {
  z = z || '0';
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

function reportMessage(level, msg) {
	if (level <= logLevel) {
		var d = new Date();
		console.log("["+pad(d.getHours(), 2)+":"+pad(d.getMinutes(), 2)+":"+pad(d.getSeconds(), 2)+"."+pad(d.getMilliseconds(), 3)+"] "+msg);
	}
}

/* returns the UTC time since the beginning of the year 
 *  should be using Date.now() but does not seem to work in NodeJS
 */
function getTime() {
	var d = new Date;
//	var n = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds())*1000 + d.getUTCMilliseconds();
	var n = d.getTime();
	return n; 
}

function reportEvent(type, event, filename){		
	var file_size = 0;
	/* need to check if the file exists because of file deletion (MP4Box and DashCast time-shift feature) */
	if (fs.existsSync(filename)) {
		var fd = fs.openSync(filename, 'r');
		file_size = fs.fstatSync(fd).size;
		fs.closeSync(fd);
	}
	reportMessage(logLevels.DEBUG_BASIC, type + " event (" + event + ") on "+filename+" (size "+file_size+")");
}

function sendAndUpdateBuffer(response, message, fileData, endpos) {
	var tmpBuffer;
	fileData.total_sent += endpos;
	reportMessage(sendMediaSegmentsFragmented ? logLevels.INFO : logLevels.DEBUG_BASIC, "Sending "+message+" data from " + fileData.next_byte_to_send + " to " + (endpos - 1) + " in " + (getTime() - response.startTime) + " ms (total_sent: "+fileData.total_sent+") at utc "+ getTime());
	tmpBuffer = fileData.buffer.slice(fileData.next_byte_to_send, endpos);
	response.write(tmpBuffer);
	fileData.nb_valid_bytes -= tmpBuffer.length;
	
	reportMessage(logLevels.DEBUG_MAX, "Resizing buffer - old length: " + fileData.buffer.length);
	fileData.buffer = fileData.buffer.slice(endpos);
	reportMessage(logLevels.DEBUG_MAX, "New buffer length:" + fileData.buffer.length);
	
	reportMessage(logLevels.DEBUG_MAX, "Resetting next offset for box reading and data sending");
	fileData.next_byte_to_send = 0;
	fileData.next_box_start = 0;
	
	fileData.write_offset -= endpos;
	reportMessage(logLevels.DEBUG_MAX, "Updating next buffer write offset: " + fileData.write_offset + ' - next 8 bytes:');

	if (logLevel == logLevels.DEBUG_MAX) console.log(fileData.buffer.slice(0,8));

	return fileData.buffer;
}

function readFileIntoBuffer(fileData) {
	var offset = fileData.write_offset;
	var buffer = fileData.buffer;
	var j = fileData.next_file_position;
	
	if (offset >= buffer.length) {
		/* increase the buffer size if we don't have enough to read in */
		buffer = Buffer.concat( [ buffer, new Buffer(100000) ], buffer.length + 100000);						
		fileData.buffer = buffer;
	}

	reportMessage(logLevels.DEBUG_MAX, "Trying to read " + (buffer.length - offset) + " bytes from file from position: " + j);
	var bytesRead = fs.readSync(fileData.fd, buffer, offset, buffer.length - offset, j);
	reportMessage(logLevels.DEBUG_MAX, "bytesRead: " + bytesRead);
	if (logLevel == logLevels.DEBUG_MAX) console.log(buffer.slice(0,100));
	j = j + bytesRead;

	reportMessage(logLevels.DEBUG_MAX, "next file read position: " + j);

	fileData.next_file_position = j;
	fileData.write_offset += bytesRead;
	fileData.nb_valid_bytes += bytesRead ;
	
}

var state = {
	NONE : "none",
	MOOV : "moov",
	MOOF : "moof",
	MDAT : "mdat"
};

function readFromBufferAndSendBoxes(response, fileData) {
	var box_start = fileData.next_box_start;
	var buffer = fileData.buffer;

	reportMessage(logLevels.DEBUG_MAX, "Reading new box from buffer position: " + box_start + " - length: "+ buffer.length);
	if (logLevel == logLevels.DEBUG_MAX) console.log(buffer.slice(0,8));

	if (box_start + 8 > fileData.nb_valid_bytes) {
		reportMessage(logLevels.DEBUG_BASIC, "Not enough data in buffer to read box header: " + box_start + " - length: "+ buffer.length + " - nb valid bytes: " + fileData.nb_valid_bytes);
		return "not-enough";
	} 
	
	var boxLength = buffer.readUInt32BE(box_start);

	var val1 = String.fromCharCode(buffer.readUInt8(box_start + 4));
	var val2 = String.fromCharCode(buffer.readUInt8(box_start + 5));
	var val3 = String.fromCharCode(buffer.readUInt8(box_start + 6));
	var val4 = String.fromCharCode(buffer.readUInt8(box_start + 7));

	reportMessage(logLevels.DEBUG_BASIC, "Parsing box: code: " + val1 + val2 + val3 + val4 + " length: " + boxLength + " - parsing state: " + fileData.parsing_state);
	
	if (boxLength == 0) {
		reportMessage(logLevels.DEBUG_BASIC, "Box length 0, stopping parsing");
		return "stop";
	} 
  if (box_start + boxLength > fileData.nb_valid_bytes) {
		/*
		 * there is not enough data in the buffer to skip the box 
		 * coming back to the beginning of the box and
		 * exiting for new buffer allocation and additional read
		 * from file
		 */
		reportMessage(logLevels.DEBUG_MAX, "Not enough data in buffer to skip the box ("+box_start+"/"+fileData.nb_valid_bytes+")");
		fileData.next_box_start = box_start;
		reportMessage(logLevels.DEBUG_MAX, "Saving start position of the box for next read: " + fileData.next_box_start);
		return "not-enough";
	} 
  
  box_start += boxLength;
	fileData.next_box_start = box_start;
		
	if (val1 + val2 + val3 + val4 == SEGMENT_MARKER) {
		reportMessage(logLevels.DEBUG_BASIC, "**************** End of segment ****************");
		buffer = sendAndUpdateBuffer(response, "eods", fileData, fileData.next_box_start);
		fileData.endOfSegmentFound = true;
		return "end";
	}

	switch (fileData.parsing_state) {
	case "none":		
		if (val1 + val2 + val3 + val4 == "moov") {
			buffer = sendAndUpdateBuffer(response, "moov", fileData, fileData.next_box_start);
			fileData.parsing_state = state.MOOV; 
    } else if (val1 + val2 + val3 + val4 == "moof") {
			fileData.parsing_state = state.MOOF; 
		} else {
			/* wait for another box */
		}
		break;

	case "moov":
		if (val1 + val2 + val3 + val4 == "moof") {
			fileData.parsing_state = state.MOOF; 
		} else {
			/* wait for another box */
		}
		break;

	case "moof":
		if (val1 + val2 + val3 + val4 == "mdat") {
			buffer = sendAndUpdateBuffer(response, "mdat", fileData, fileData.next_box_start);
			reportMessage(logLevels.DEBUG_BASIC, "Fragment sent at utc "+getTime());
			fileData.parsing_state = state.MOOV;
		} else {
			/* wait for another box */
		}
		break;
	}
	return "ok";			
}

function Parameters( multipleFiles, initial_state, response, filename) {
	this.buffer = new Buffer(100000);
	this.parsing_state = initial_state;
	this.nb_valid_bytes = 0;
	this.next_file_position = 0;
	this.total_sent = 0;
	this.next_byte_to_send = 0;
	this.next_box_start = 0;
	this.write_offset = 0;
	this.request = false;
	this.checkEndOfSegment = multipleFiles;
	this.endOfSegmentFound = false;
	this.response = response;
	this.listener = null;
	this.endSent = false;
	this.filename = filename;
}

function sendFragmentedFile(response, filename, params) {
	/* the change event may be for a file deletion */
	if (!fs.existsSync(filename)) {
		reportMessage(logLevels.DEBUG_MAX, "File filename does not exist");
		return;
	}

	/* In some modes, we don't check for specific end of marker boxes */
	if (!params.checkEndOfSegment
		|| (params.checkEndOfSegment && params.endOfSegmentFound == false)) {

		params.fd = fs.openSync(filename, 'r');
		var stats = fs.fstatSync(params.fd);
		var file_size = stats.size;
		if (file_size <= params.next_file_position) {
			reportMessage(logLevels.DEBUG_MAX, "Error: file size hasn't changed or is smaller: " + file_size);
		}

		while (true) {
			/* If there is some data to read in the file, 
			   read it (from the position next_file_position) 
			   into the buffer (at the position write_offset)*/
			if (params.next_file_position < file_size) {
				readFileIntoBuffer(params);
			} 

			/* Read boxes and send them 
			   make sure we have at least 8 bytes to read box length and box code, 
			   otherwise we need to wait for the next read */
			boxReadingStatus = readFromBufferAndSendBoxes(response, params);					
							
		
			if (params.next_file_position < file_size) {
				/* we still have some data to read from the file */
				continue;
			} else {
				/* we have read everything available from the file (for now) */
				if (boxReadingStatus == "ok") {
					/* we haven't finished reading boxes, keep on reading */
					continue;
				} else if (boxReadingStatus == "not-enough") { 
					/* quit and wait for another file change event */
					reportMessage(logLevels.DEBUG_BASIC, "Not enough data to read the full box");
					if (params.listener == null) {
						if (use_watchFile) {
							params.listener = fs.watchFile(filename, watchFileOptions, watchFileListener.bind(params));
						} else {
							params.listener = fs.watch(filename, watchOptions, watchListener.bind(params));
						}
					}
					break;
				} else if (boxReadingStatus == "stop") {
					/* reset the parser, the data written in the file by GPAC/MP4Box is not ready to be read yet
					   quit and wait for another file change event */
					reportMessage(logLevels.DEBUG_BASIC, "Resetting parser - GPAC data not ready yet");
					params.next_file_position -= (params.nb_valid_bytes - params.next_box_start);
					reportMessage(logLevels.DEBUG_MAX, "Next file position is now "+params.next_file_position);
					params.write_offset -= (params.nb_valid_bytes - params.next_box_start);
					params.nb_valid_bytes = params.next_box_start;
					if (params.listener == null) {
						if (use_watchFile) {
							params.listener = fs.watchFile(filename, watchFileOptions, watchFileListener.bind(params));
						} else {
							params.listener = fs.watch(filename, watchOptions, watchListener.bind(params));
						}
					}
					break;
				} else if (boxReadingStatus == "end") {
					reportMessage(logLevels.DEBUG_BASIC, "end reached");
					if (use_watchFile) {
						fs.unwatchFile(filename, params.listener);
					} else if (params.listener) {
						params.listener.close();
					}
					params.listener = null;
					/* Quit */
					break;
				}
			}
		}
		
		/* mark that the data from this file can be sent the next time its content will be refreshed 
		  (to send the very latest fragment first) */
		params.request = true;
		if (params.endOfSegmentFound) {
			var resTime = getTime() - response.startTime;
			reportMessage(logLevels.INFO, "end of file reading ("+filename+") in " + resTime + " ms at UTC " + getTime() );
			params.response.end();
			params.endSent = true;
			if (params.listener) {
				params.listener.close();
			}
		}
		reportMessage(logLevels.DEBUG_MAX, " next file read position: " + params.next_file_position);
		reportMessage(logLevels.DEBUG_MAX, " buffer size: " + params.buffer.length);
		reportMessage(logLevels.DEBUG_MAX, " next buffer read position: " + params.next_box_start);
		reportMessage(logLevels.DEBUG_MAX, " next buffer write position: " + params.write_offset);
		reportMessage(logLevels.DEBUG_MAX, " next buffer send start position: " + params.next_byte_to_send);
		
		fs.closeSync(params.fd);
		
	}
}

/* Callback function used when an file event is generated, the file is sent in a fragmented manner 
 * The listener is not removed
 */
function watchListener(event, filename) {
	var boxReadingStatus;
	
	if (event == 'change') {
		reportEvent("file", event, filename);
		sendFragmentedFile(this.response, this.filename, this);
	} else {
		reportEvent("file", event, filename);
  }
}

function watchFileListener(curr, prev) {
	var boxReadingStatus;
	
	sendFragmentedFile(this.response, this.filename, this);
}


function sendFile(res, filename) {
	var file_stream = fs.createReadStream(filename);
	reportMessage(logLevels.DEBUG_BASIC, "Sending file ("+filename+")");
	file_stream.on("error", function(exception) {
		console.error("Error reading file ("+filename+")", exception);
	});
	file_stream.on("data", function(data) {
		res.write(data);
	});
	file_stream.on("close", function() {	
		reportMessage(logLevels.DEBUG_BASIC, "Done sending file ("+filename+")" + "in " + (getTime() - res.startTime) + " ms");
		res.end();
	});
}

var onRequest = function(req, res) {

	var parsed_url = url_parser.parse(req.url, true);
	// console.log(parsed_url);
	 /* we send the files as they come, except for segments for which we send fragment by fragment */
	var head = {};
	if (!fs.existsSync(parsed_url.pathname.slice(1))) {
		reportMessage(logLevels.INFO, "Request for non existing file: "+ parsed_url.pathname.slice(1) + " at UTC "+getTime());
		res.writeHead(404, head);
		res.end();
    return;
	} else {
		res.startTime = getTime();
		reportMessage(logLevels.INFO, "Request for file: "+ parsed_url.pathname.slice(1)  + " at UTC " + res.startTime ) ;
	}

	if (parsed_url.pathname.slice(-3) === "mpd") {
		head = {
			'Content-Type' : 'application/dash+xml',
    		'Server-UTC': ''+getTime() 
		};
		res.writeHead(200, head);
		sendFile(res, parsed_url.pathname.slice(1));
    return;
	} 

  var filename = parsed_url.pathname.slice(1);
  var params = new Parameters(false, state.NONE, res, filename);
  
  if (parsed_url.pathname.slice(-3) === "mp4") {
		head = {
			'Content-Type' : 'video/mp4',
    		'Server-UTC': ''+getTime() 
		};
		res.writeHead(200, head);
    
		/* TODO: Check if we should send MP4 files as fragmented files or not */
		if (sendInitSegmentsFragmented) {
		  sendFragmentedFile(res, filename, params);
		  /* Sending the final 0-size chunk because the file won't change anymore */
		  res.end();
		  reportMessage(logLevels.INFO, "file "+ parsed_url.pathname.slice(1) + " sent in " + (getTime() - res.startTime) + " ms");
		} else {
		  sendFile(res, filename);
		}
	} else if (parsed_url.pathname.slice(-3) === "m4s") {
		head = {
			'Content-Type' : 'application/octet-stream',
    		'Server-UTC': ''+getTime() 
		};
		res.writeHead(200, head);
		if (sendMediaSegmentsFragmented) {
			sendFragmentedFile(res, filename, params);
		} else {
			sendFile(res, filename);
		}
	}
}

process.argv.splice(1).forEach(function(val, index, array) {
	// console.log(index + ': ' + val + " / " + array[index + 1]);
	if (index == 0) {
		reportMessage(logLevels.INFO, "Runnning " + val +" using "+process.execPath+" version "+process.version+" in "+process.cwd());
	}
	if (val === "-ip") {
		ipaddr = array[index + 1];
	} else if (val === "-port") {
		port = array[index + 1];
	} else if (val === "-log") {
		if (array[index + 1] === "info") {
			logLevel = logLevels.INFO;
		} else if (array[index + 1] === "debug-basic") {
			logLevel = logLevels.DEBUG_BASIC;
		} else if (array[index + 1] === "debug-max") {
			logLevel = logLevels.DEBUG_MAX;
		}
	} else if (val === "-timing") {
		logTiming = true;
	} else if (val === "-segment-marker") {
		SEGMENT_MARKER = array[index + 1];
	} else if (val === "-chunk-media-segments") {
		sendMediaSegmentsFragmented = true;
	} else if (val === "-use-watchFile") {
		use_watchFile = true;
	}
});

http.createServer(onRequest).listen(port, ipaddr);
reportMessage(logLevels.INFO, "Server running on " + ipaddr + ":" + port + " in "+(sendMediaSegmentsFragmented ? "low-latency": "normal")+" mode");
