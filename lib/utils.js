'use strict'

const stream = require('stream')
const util = require('util')
const debuglog = util.debuglog('cstream')

exports.getKeyByValue = function (object, value) {
  return Object.keys(object).find(key => object[key] === value);
}

exports.once = function (fn, context) {
  let result
  return function () {
    if (fn) {
      result = fn.apply(context || this, arguments)
      fn = context = null
    }
    return result
  }
}

const zero = function (n, max) {
  n = n.toString(16).toUpperCase();
  while (n.length < max) {
    n = '0' + n;
  }
  return n;
}

exports.hex = function (buffer, offset = false) {
  var rows = Math.ceil(buffer.length / 16);
  var last = buffer.length % 16 || 16;
  var offsetLength = buffer.length.toString(16).length;
  if (offsetLength < 6) offsetLength = 6;

  let str = ''

  if (offset) {
    str = 'Offset';
    while (str.length < offsetLength) {
      str += ' ';
    }

    str = '\u001b[36m' + str + '  ';

    var i;
    for (i = 0; i < 16; i++) {
      str += ' ' + zero(i, 2);
    }
  }
  str += '\u001b[0m\n';
  if (buffer.length) str += '\n';

  var b = 0;
  var lastBytes;
  var lastSpaces;
  var v;

  for (i = 0; i < rows; i++) {
    str += '\u001b[36m' + zero(b, offsetLength) + '\u001b[0m  ';
    lastBytes = i === rows - 1 ? last : 16;
    lastSpaces = 16 - lastBytes;

    var j;
    for (j = 0; j < lastBytes; j++) {
      str += ' ' + zero(buffer[b], 2);
      b++;
    }

    for (j = 0; j < lastSpaces; j++) {
      str += '   ';
    }

    b -= lastBytes;
    str += '   ';

    for (j = 0; j < lastBytes; j++) {
      v = buffer[b];
      str += (v > 31 && v < 127) || v > 159 ? String.fromCharCode(v) : '.';
      b++;
    }

    str += '\n';
  }

  return str
}

// offsets start of the stream
class OffsetStream extends stream.Transform {
    constructor (opts) {
        super(opts)
        if (opts.offset) this._offset = opts.offset
        this._consumed = 0
    }

    _transform (data, encoding, callback) {
        debuglog(`OFST _tranform: data len:${data.length}, total: ${this._consumed}`)
        this._consumed += data.length
        const consumed_past_offset = this._consumed - this._offset
        const chunk_offset = data.length - consumed_past_offset
        if (consumed_past_offset < 0) return callback()
        if (chunk_offset > 0) {
            debuglog(`OFST _transform: will cut chunk off at ${chunk_offset}. offset=${this._offset}`)
            if (Buffer.isBuffer(data)) {
                data = data.slice(chunk_offset)
            } else if (typeof data === 'string') {
                data = data.substring(chunk_offset)
            } else {
                throw new Error('wtf type')
            }
        }
        callback(null, data)
    }
    _flush (callback) {
        debuglog(`OFST _flush`)
        this.push(null)
        callback()
    }
}

class ChunkerStream extends  stream.Transform {
    constructor (opts = {}) {
        opts.autoDestroy = true
        super(opts)
        this._chunk_size = opts.chunk_size
        this._craft_header = opts.craft_header
        this._controlled = opts.controlled || false
        this._consumed = 0
        this._snubbed = false
        this._buffered_size = 0
        this._bucket = []
        this._craft_header_for_chunk_size = () => this._craft_header(this._chunk_size)
        debuglog(`CS _init: chunk size: ${this._chunk_size}`)
    }

    async _green_light () {
        if (this._controlled) {
            if (this._snubbed) {
                if (this.listenerCount('snubbed') === 0) throw Error("CS: no 'snubbed' handlers registered for this stream")
                let unsnub_fun
                const promise = new Promise((resolve, reject) => {
                    unsnub_fun = (err, data) => {
                        if (err) reject(err)
                        else resolve(data)
                        unsnub_fun = undefined
                    }
                })
                debuglog(`CS _green_light: waiting for trigger`)
                this.emit('snubbed', unsnub_fun)
                return promise
            }
            this._snubbed = true
        }
    }

    async _transform (data, encoding, callback) {
        const data_len = data.length
        debuglog(`CS _transform: got data len:${data_len}, consumed: ${this._consumed}, buffered_size: ${this._buffered_size}`)
        this._consumed += data_len
        const combined_data_len = this._buffered_size + data_len
        const overflew_by = combined_data_len - this._chunk_size

        // not enough data to fill the chunk
        if (overflew_by < 0) {
            this._bucket.push(data)
            this._buffered_size += data_len
            return callback()
        }
        try {
            await this._green_light()
            debuglog(`CS _transform: green light passed`)

            // enough data, chop it off
            this.push(this._craft_header_for_chunk_size())

            // drain the bucket first
            this._bucket.forEach(this.push.bind(this))

            const data_cutoff = this._chunk_size - this._buffered_size

            // chop off first data piece till chunk boundary
            this.push(data.slice(0, data_cutoff))

            const full_chunks_cnt = Math.floor(combined_data_len / this._chunk_size)
            let cutoff_offset = data_cutoff
            // iterate through chunk-sized data+bucket, if any
            for (; cutoff_offset < full_chunks_cnt * this._chunk_size - this._buffered_size; cutoff_offset += this._chunk_size) {
                await this._green_light()
                debuglog(`CS _transform: green light passed`)

                this.push(this._craft_header_for_chunk_size())
                // push the sliced data
                this.push(data.slice(cutoff_offset, cutoff_offset + this._chunk_size))
            }

            this._buffered_size = data_len - cutoff_offset
            this._bucket = [data.slice(cutoff_offset)] // push data tail to empty bucket
            callback()
        } catch (err) {
            debuglog(`CS _transform: caught Error: ${err}`)
            this.destroy(err)
            callback(err)
        }
    }

    async _flush (callback) {
        debuglog(`CS _flush. buffered_size:${this._buffered_size}`)
        if (this._buffered_size > 0) {
            try {
                if (this._buffered_size > this._chunk_size) throw new Error('badcode: too much data in the buffer')

                await this._green_light()
                debuglog(`CS _flush: green light passed`)

                this.push(this._craft_header(this._buffered_size))
                this._bucket.forEach(this.push.bind(this))
            } catch (err) {
                debuglog(`CS _flush: caught Error: ${err}`)
                this.destroy(err)
                return callback(err)
            }
        }
        this._buffered_size = 0
        this._bucket = []
        this.push(null)
        debuglog(`CS _flush: done, about to call cb()`)
        callback()
    }
}

class SplitStream extends stream.Transform {
    constructor(opts) {
        super(opts)
        this._buf = []
    }

    _transform (chunk, encoding, cb) {
        let prev_idx = 0, idx = 0
        while ((idx = chunk.indexOf(0xa, prev_idx)) > -1) {
            this._flushbuf()
            if (idx > 0 && chunk[idx - 1] === 0xd) { // "\r\n"
                this.push(Buffer.concat([chunk.slice(prev_idx, idx - 1), Buffer.from([0xd, 0xa])]))
            } else { // "\n"
                this.push(Buffer.concat([chunk.slice(prev_idx, idx), Buffer.from([0xd, 0xa])]))
            }
            prev_idx = idx + 1
        }
        if (idx < chunk.length - 1) {
            this._buf.push(chunk.slice(idx))
        }
        cb()
    }

    _flush (cb) {
        this._flushbuf()
        this.push(null)
        cb()
    }
    _flushbuf () {
        if (this._buf.length > 0) this._buf.forEach(this.push.bind(this))
    }
}

exports.OffsetStream = OffsetStream
exports.ChunkerStream = ChunkerStream
exports.SplitStream = SplitStream
