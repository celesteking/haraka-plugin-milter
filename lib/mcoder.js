/// milter proto transcoder

const util = require('util')
const net = require('net')
const stream = require('stream')
const debuglog = util.debuglog('cmilter')
const mconsts = require('./constants')
const mutils = require('./utils')

class Mcoder {
    constructor ({log, config, connection}) {
        this.config = config
        this.connection = connection

        this.setup_logging(log)
    }

    // encode command + supplied data length
    static cmd_encode ({cmd_char, data_buf}) {
        const data_buf_len = data_buf == null ? 0 : data_buf.length
        const buf = Buffer.allocUnsafe(mconsts.MILTER_LEN_BYTES + 1 + data_buf_len) // uint32(len) + char(cmd) + buf.length

        buf.writeUInt32BE(1 + data_buf_len, 0) // char(cmd) + buf.length
        buf.write(cmd_char, mconsts.MILTER_LEN_BYTES)
        if (data_buf_len > 0) data_buf.copy(buf, mconsts.MILTER_LEN_BYTES + 1)
        return buf
    }

    // encode command + forthcoming data length
    static cmd_len_encode(cmd_char, data_len) { // !
        const buf = Buffer.allocUnsafe(mconsts.MILTER_LEN_BYTES + 1) // uint32(len) + char(cmd)
        buf.writeUInt32BE(1 + data_len, 0) // char(cmd) + buf.length
        buf.write(cmd_char, mconsts.MILTER_LEN_BYTES)
        return buf
    }

    optneg_encode ({version = mconsts.SMFI_VERSION, actions = this.config.actions.union, features = this.config.features.union}) {
        // uint32	version		SMFI_VERSION (2)
        // uint32	actions		Bitmask of allowed actions from SMFIF_*
        // uint32	protocol	Bitmask of possible protocol content from SMFIP_*

        const dbuf = Buffer.alloc(32/8*3)
        dbuf.writeUInt32BE(version, 0)
        dbuf.writeUInt32BE(actions, mconsts.MILTER_LEN_BYTES)
        dbuf.writeUInt32BE(features, mconsts.MILTER_LEN_BYTES * 2)

        return dbuf
    }

    optneg_decode (buf) {
        const version = buf.readUInt32BE(0)
        const actions = buf.readUInt32BE(mconsts.MILTER_LEN_BYTES)
        const features = buf.readUInt32BE(mconsts.MILTER_LEN_BYTES * 2)

        return { version,
            actions: {union: actions, list: mconsts.unfold_const_names('SMFIF', actions)},
            features: {union: features, list: mconsts.unfold_const_names('SMFIP', features)},
        }
    }

    macro_encode (cmdcode, kvlist) {
        return Buffer.concat([
            Buffer.from(cmdcode),
            ...Object.keys(kvlist).reduce((acc, name) => {
                if (kvlist[name] != null && name != null) {
                    acc.push(Buffer.from(name), Buffer.from([0]), Buffer.from(kvlist[name]), Buffer.from([0]))
                }
                return acc
            }, []),
        ])
    }

    connect_encode ({hostname, family, port, address}) {
        // char	hostname[]	Hostname, NUL terminated
        // char	family		Protocol family (see below)
        // uint16	port		Port number (SMFIA_INET or SMFIA_INET6 only)
        // char	address[]	IP address (ASCII) or unix socket path, NUL terminated
        const pbuf = Buffer.alloc(16 / 8)
        pbuf.writeUInt16BE(port, 0)

        return Buffer.concat([
            Buffer.from(hostname), Buffer.from([0x00]),
            Buffer.from(family),
            pbuf,
            Buffer.from(address), Buffer.from([0x00])
        ])
    }

    // mail or rcpt
    mailrcpt_encode ({addr, esmtp_params = []}) {
        // char	args[][]    Array of strings, NUL terminated (address at index 0).
        //      args[0]     is sender, with <> qualification.
        // 		args[1]     and beyond are ESMTP arguments, if any.
        return Buffer.concat([
            Buffer.from(addr), Buffer.from([0x00]),
            ...esmtp_params.map((str) => Buffer.concat([Buffer.from(str), Buffer.from([0x00])])),
        ])
    }

    disposition_decode ({cmd_name, data}) {
        const reply = {cmd_name}
        if (cmd_name === 'REPLYCODE') {
            Object.assign(reply, this.replycode_decode({data}))
        }
        return reply
    }

    modaction_decode ({cmd_name, data}) {
        switch (cmd_name) {
            case 'ADDRCPT':
            case 'DELRCPT':
                return {type: cmd_name, rcpt: this.decode_null_str(data)}
            case 'REPLBODY':
                return {type: cmd_name, body: data}
            case 'ADDHEADER':
                return {type: cmd_name, header: this.kv_header_decode(data)}
            case 'INSHEADER':
                return {type: cmd_name, header: this.kv_header_idx_decode(data)}
            case 'CHGHEADER':
                return {type: cmd_name, header: this.kv_header_idx_decode(data)}
            case 'QUARANTINE':
                return {type: cmd_name, reason: this.decode_null_str(data)}
        }
        throw new Error('modification action not implemented')
    }

    kv_header_encode ({name, value}) {
        // char	name[]		Name of header, NUL terminated
        // char	value[]		Value of header, NUL terminated
        return Buffer.concat([
            Buffer.from(name), Buffer.from([0x00]),
            Buffer.from(value), Buffer.from([0x00]),
        ])
    }

    kv_header_decode (buf) {
        // char	name[]		Name of header, NUL terminated
        // char	value[]		Value of header, NUL terminated
        const i1 = buf.indexOf(0)
        const i2 = buf.indexOf(0, i1 + 1)
        return {name: buf.toString('utf8', 0, i1), value: buf.toString('utf8', i1 + 1, i2)}
    }

    kv_header_idx_decode (buf) {
        // uint32	index		Index of the occurrence of this header
        // char	    name[]		Name of header, NUL terminated
        // char	    value[]		Value of header, NUL terminated
        const index = buf.readUInt32BE(0)
        const i1 =  buf.indexOf(0, 4)
        const i2 =  buf.indexOf(0, i1 + 1)
        return {name: buf.toString('utf8', 4, i1), value: buf.toString('utf8', i1 + 1, i2), index}
    }

    replycode_decode ({data}) {
        if (data[3] !== 0x20) throw new Error('badproto: err decoding')
        return {smtpcode: data.slice(0, 3).toString(), reason: data.slice(4, data.length - 1).toString()}
    }

    decode_null_str (buf) {
        return buf.slice(0, buf.length - 1).toString()
    }

    setup_logging (log) {
        this.log = {}
        for (const lvl of Object.keys(log)) {
            this.log[lvl] = (msg) => log[lvl](`⦓mcoder⦔ ${msg}`)
        }
    }
}

module.exports = Mcoder
