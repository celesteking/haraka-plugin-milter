'use strict'

const util = require('util')
const net = require('net')
const stream = require('stream')
const dbgclog = util.debuglog('cmilter')
const dbgmlog = util.debuglog('mstream')
const mconsts = require('./constants')
const mutils = require('./utils')
const hexit = require('./utils').hex
const Mcoder = require('./mcoder')
const sleep = util.promisify(setTimeout)

class CMilterError extends Error {
    constructor (type = 'generic', ...params) {
        super(...params)

        if (Error.captureStackTrace) Error.captureStackTrace(this, CMilterError)

        this.name = 'CustomError'
        this.type = type
    }
}

class CMilter {
    constructor ({config, logger, connection}) {
        this.log = {}

        this._id = config.name
        this._error = false
        this._read_cb = null
        // negotiated actions
        this._actions = []
        // negotiated protocol features / flags
        this._features = []
        // last sent command (SMFIC)
        this._command = null

        this.config = config
        this.connection = connection

        this.attach_logger()

        this.mstream = new MilterStream({log: this.log, config})
        this.mcoder = new Mcoder({log: this.log, config, connection})

        this.attach_mstream_events()

        this.log.debug(`CMilter[${this._id}] initialized.`)
    }

    attach_logger () {
        for (const lvl of ['debug', 'info', 'notice', 'warn', 'error']) {
            this.log[lvl] = this[`log${lvl}`] = (msg) => this.connection[`log${lvl}`]({name: 'Cmilter'}, `(${this._id}) ${msg}`)
        }
    }

    attach_mstream_events () {
        this.mstream
            .on('error', (e) => {
                this.error_state = true
                this.log.debug(`mstream: 'error' event received: ${e}`)
            })
            .on('end', () => {
                dbgclog(`mstream: 'end' event received. about to call mstream.end().`)
                if (this.mstream.writable) {
                    this.mstream.end()
                }
            })
            .on('close', had_error => {
                dbgclog(`mstream: 'close' event received. had_error=${had_error}`)
            })
            .on('timeout', () => {
                this.log.warn(`mstream: 'timeout' event received`)
            })
    }

    async phase(cmd_name, params) {
        if (cmd_name === 'BODY') {
            dbgclog(`phase: BODY ✖ hook=${this.connection.hook} ✖ params={message_stream: ...}`)
        } else {
            dbgclog(`phase: ${cmd_name} ✖ hook=${this.connection.hook} ✖ params=${util.inspect(params, {compact: true, colors: true, breakLength: 200})}`)
        }
        let response = {code: 'CONTINUE'}

        const err_response = Object.assign({msg: 'cmilter is in error state'}, response)
        if (this._error) return err_response

        try {
            let reply
            switch (cmd_name) {
                case 'OPTNEG':
                case 'MACRO':
                case 'CONNECT':
                case 'HELO':
                    // await this._dispatcher({cmd_name, params})
                    // break
                case 'MAIL':
                    // await sleep(5000)
                case 'RCPT':
                case 'DATA':
                case 'HEADER':
                case 'EOH':
                case 'BODY':
                    reply = await this._dispatcher({cmd_name, params})
                    break
                case 'BODYEOB':
                    reply = await this._send_bodyeob()
                    return Object.assign({code: reply.disposition.cmd_name, modactions: reply.modactions}, reply.disposition)
                case 'QUIT':
                    await this._send_quit()
                    this.mstream = null
                    return response
                default:
                    throw new Error(`unknown command supplied: ${cmd_name}!`)
            }
            return {code: reply.cmd_name, msg: reply.msg}
        } catch (err) {
            if (err instanceof CMilterError) {
                this.log.error(`cmilter incurred an error: ${err.name}: [${err.type}] ${err.message}`)
                this.error_state = true
                return err_response
            }
            throw err // rethrow other errors
        }

        return response
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    _craft_optneg ({cmd_name}) {
        const my_ver = mconsts.SMFI_VERSION

        return {
            create_request: async ({params}) => {
                this.log.debug(`cmd_optneg >>: ◉ MINE ◉ ver=${my_ver} ● actions=${this.config.actions.list} ● pflags=${this.config.features.list}`)
                return { data: this.mcoder.optneg_encode({version: my_ver, actions: this.config.actions.union, features: this.config.features.union}) }
            },
            handle_response: async ({reply}) => {
                const peer = this.mcoder.optneg_decode(reply.data)

                this.log.debug(`cmd_optneg <<: ◼ PEER (== negotiated) ◼ ver=${peer.version} ● actions=${peer.actions.list} ● pflags=${peer.features.list}`)

                const peer_ver = peer.version
                // agree on actions & flags
                if (peer_ver !== my_ver) {
                    this.log.notice(`cmd_optneg: version mismatch! my:${my_ver} peer:${peer_ver}`)
                    if (peer_ver >= mconsts.SMFI_MIN_VERSION && peer_ver < my_ver) {
                        // okay
                    } else if (peer_ver > my_ver) {
                        throw new CMilterError('protocol', `peer MILTER version (${peer_ver}) higher than supported (${my_ver})!`)
                    }
                }

                this._features = peer.features.list
                this._actions = peer.actions.list

                const unwanted_features = this._features.filter((n) => !this.config.features.list.includes(n))
                if (unwanted_features.length > 0) {
                    this.log.warn(`cmd_optneg: peer pushed unwanted features that I didn't ask for: ${unwanted_features}, continuing...`)
                }
                const unwanted_actions = this._actions.filter((n) => !this.config.actions.list.includes(n))
                if (unwanted_actions.length > 0) {
                    this.log.warn(`cmd_optneg: peer pushed unwanted actions that I didn't ask for: ${unwanted_actions}, continuing...`)
                }

                const knocked_out_features = this.config.features.list.filter((n) => !this._features.includes(n))
                if (knocked_out_features.length > 0) {
                    this.log.notice(`cmd_optneg: peer knocked out features that I advertised: ${knocked_out_features}`)
                }

                const knocked_out_actions = this.config.actions.list.filter((n) => !this._actions.includes(n))
                if (knocked_out_actions.length > 0) {
                    this.log.notice(`cmd_optneg: peer knocked out actions that I advertised: ${knocked_out_actions}`)
                }
            }
        }
    }

    _craft_macro ({cmd_name}) {
        return {
            create_request: async ({params}) => {
                const {cmdcode, kvlist} = params
                this.log.debug(`cmd_macro >>: cmdcode=${cmdcode} kvlist=${util.inspect(kvlist, {compact: true, breakLength: 200})}`)
                return {data: this.mcoder.macro_encode(cmdcode, kvlist)}
            },
        }
    }

    _craft_connect ({cmd_name}) {
        return {
            create_request: async ({params}) => {
                const hostname = this.connection.remote.host
                const ip = this.connection.remote.ip
                const port = this.connection.remote.port

                if (net.isIPv4(ip)) {
                    var proto_family = mconsts.SMFIA.INET
                } else if (net.isIPv6(ip)) {
                    proto_family = mconsts.SMFIA.INET6
                } else {
                    proto_family = mconsts.SMFIA.UNKNOWN
                }

                this.log.debug(`cmd_connect >>: hostname=${hostname} family=${proto_family}, port=${port}, address=${ip}`)
                return {data: this.mcoder.connect_encode({hostname, family: proto_family, port, address: ip})}
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_connect <<: ${util.inspect(reply)}`)
            }
        }
    }

    _craft_helo ({cmd_name}) {
        return {
            create_request: async ({params}) => {
                const fqdn = this.connection.hello.host

                this.log.debug(`cmd_helo>>: helo=${fqdn}`)
                return {data: fqdn}
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_helo <<: ${util.inspect(reply)}`)
            }
        }
    }

    _craft_mail ({cmd_name}) {
        return {
            create_request: async ({params}) => {
                const sender = params[0].toString()
                const esmtp_params = params[1]
                this.log.debug(`cmd_mail >>: sender=${sender}, esmtp_params=${esmtp_params}`)
                return {data: this.mcoder.mailrcpt_encode({addr: sender, esmtp_params})}
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_mail <<: ${util.inspect(reply)}`)
            }
        }
    }

    _craft_rcpt ({cmd_name}) {
        return {
            create_request: async ({params}) => {
                const rcpt = params[0].toString()
                const esmtp_params = params[1]
                this.log.debug(`cmd_rcpt >>: rcpt=${rcpt}, esmtp_params=${esmtp_params}`)
                return {data: this.mcoder.mailrcpt_encode({addr: rcpt, esmtp_params})}
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_rcpt <<: ${util.inspect(reply)}`)
            }
        }
    }

    _craft_header ({cmd_name}) {
        return {
            create_request: async ({params: {name, value}}) => {
                this.log.debug(`cmd_header >>: ${name}:${value} ${this.want_header_leading_space ? '[LEADSPACE ON]' : '[leadspace removed]'}`)
                return {data: this.mcoder.kv_header_encode({name, value: this.want_header_leading_space ? value : value.trimStart()})}
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_header <<: ${util.inspect(reply)}`)
            }
        }
    }

    _craft_body ({cmd_name}) {
        return {
            create_request: async ({params: {message_stream}}) => {
                this.log.debug(`cmd_body >>: sending message body...`)
                return { data: message_stream }
            },
            handle_response: async ({reply}) => {
                this.log.debug(`cmd_body <<: ${util.inspect(reply)}`)
            }
        }
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // state transition machinery
    async _dispatcher ({cmd_name, params}) {
        // dispatch commands according to state
        // invoke this._craft_${cmd}() that would return {create_request: (cmd_name, params) => req_obj, handle_response: (cmd_name, params) => resp_obj }
        //   req_obj: {data: Buffer, }
        //   resp_obj: any
        //   params: map of specific cmd crafter params

        const switchbox = this._ensure_switchbox_transition_compliance(cmd_name)

        if (this._should_skip_sending_command(cmd_name)) {
            this.log.debug(`_dispatcher: Configured/Negotiated to skip sending ${cmd_name}, thus skipping it.`)
            return {code: 'CONTINUE'}
        }

        this._command = cmd_name

        let req_data
        const craft_func = this[`_craft_${cmd_name.toLowerCase()}`]
        if (!craft_func) {
            this.log.debug(`_dispatcher: no crafter defined for ${cmd_name}, thus sending a simple command`)
        } else {
            var crafter = craft_func.call(this, {cmd_name})
            if (crafter.create_request) {
                const req_obj = await crafter.create_request({params})
                if (req_obj && req_obj.data) {
                    req_data = req_obj.data
                }
            }
        }

        const expect_reply = !this._should_skip_expecting_reply(cmd_name)

        // send command
        const reply = await this._talk_to_mstream(cmd_name, req_data, expect_reply)

        if (!expect_reply) {
            this.log.debug(`_dispatcher: Configured/Negotiated to skip expecting a reply on ${cmd_name}.`)
            return {code: 'CONTINUE'}
        }

        // check reply against expected commands list
        if (!switchbox.expect.includes(reply.cmd_name)) {
            throw new CMilterError('state', `Unexpected response command name "${reply.cmd_name}". Expected: ${util.inspect(switchbox.expect)}.`)
        }

        if (craft_func && crafter.handle_response) {
            return await crafter.handle_response({reply}) || reply
        }
        return reply
    }

    // issue a BODYEOB command, waiting for modification actions followed by a disposition action
    async _send_bodyeob () {
        const cmd_name = 'BODYEOB'
        const switchbox = this._ensure_switchbox_transition_compliance(cmd_name)

        this._command = cmd_name

        let reply = await this._talk_to_mstream(cmd_name, null, false)
        const actions = {modactions: [], disposition: null}

        const read_response = util.promisify(this._read_response).bind(this)

        while (true) {
            reply = await read_response()

            // check reply against expected commands list
            if (!switchbox.expect.includes(reply.cmd_name)) {
                throw new CMilterError('state', `Unexpected response command name "${reply.cmd_name}". Expected: ${util.inspect(switchbox.expect)}.`)
            }

            if (mconsts.MILTER_ACTIONS.DISPOSITION.includes(reply.cmd_name)) {
                actions.disposition = this.mcoder.disposition_decode(reply)
                break
            }

            actions.modactions.push(this.mcoder.modaction_decode(reply))
        }
        return actions
    }

    // issue a QUIT command, waiting for milter's connection teardown
    _send_quit () {
        const cmd_name = 'QUIT'
        this._ensure_switchbox_transition_compliance(cmd_name)
        this._command = cmd_name

        return new Promise((resolve, reject) => {
            if (!this._mstream_has_no_data())
                reject(new CMilterError('state', `Residual data in mstream before invoking QUIT command.`))

            this.mstream.once('close', () => {
                this.mstream.destroy()
                resolve()
            })
            this.mstream.write({cmd: cmd_name}, (err) => {
                dbgclog(`_talk: mstream write() call completed.` + (err ? `err=${err}` : ''))
                if (err) return reject(err)
            })
        })
    }

    // Ensure new command is compliant with switchbox transitioning rules
    // @returns {Object} switchbox
    _ensure_switchbox_transition_compliance (cmd_name) {
        const switchbox = mconsts.SWITCHBOX_STATES[cmd_name]
        if (!switchbox) {
            throw new CMilterError('config', `Supplied command ${cmd_name} missing in SWITCHBOX_STATES config.`)
        }
        if (this._command) {
            const switchbox_prev = mconsts.SWITCHBOX_STATES[this._command]
            if (!switchbox_prev.next.includes(cmd_name)) {
                throw new CMilterError('state', `Unexpected state transition ${this._command} -> ${cmd_name}.`)
            }
        }
        return switchbox
    }

    _should_skip_sending_command (cmd_name) {
        const feature = mconsts.get_const_name('PROTO_CMD_SKIP_MAP', cmd_name) // command might be unskippable (missing in skip map)
        return this._features.includes(feature) // if negotiated to skip this command
    }

    _should_skip_expecting_reply (cmd_name) {
        if (['MACRO'].includes(cmd_name)) return true // always unrepliable

        const feature = mconsts.get_const_name('PROTO_REPLY_SKIP_MAP', cmd_name) // command might be missing in skip map
        return this._features.includes(feature) // if negotiated to not expect a reply to command
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    // issue a command, read the response
    _talk_to_mstream (cmd, data, expect_response = true) {
        return new Promise((resolve, reject) => {
            if (!this._mstream_has_no_data())
                reject(new CMilterError('state', `Residual data in mstream before invoking a command.`))

            this.mstream.write(
                {cmd, data, expect_response},
                (err) => {
                    dbgclog(`_talk: mstream write() call completed.` + (err ? ` err=${err}` : ''))
                    if (err) return reject(err)

                    if (expect_response) {
                        this._read_response((err, data) => {
                            if (err) return reject(err)
                            resolve(data)
                        })
                    } else {
                        resolve()
                    }
                })
        })
    }

    _mstream_has_no_data () {
        // There must be no data pending in mstream's readable. If there is, it usually means misnegotiation of NR_*.
        if (this.mstream.readableLength === 0) return true
        dbgclog(`cmilter: bad transition: mstream has residue data before sending command. len=${this.mstream.readableLength}`)
        this.error_state = true
        this.mstream.destroy()
    }

    _read_response (cb) {
        dbgclog(`_read_response() entered. mstream.readableLength=${this.mstream.readableLength}`)
        const cb_once = mutils.once((...opts) => {
            this.mstream.off('readable', on_readable).off('error', on_error).off('close', on_error)
            cb(...opts)
        }, this)

        const read_timeout = (this._command === 'BODYEOB' ? this.config.timeouts.eob : this.config.timeouts.command) || 1000
        const timer = setTimeout(() => {
            cb_once(new CMilterError('timeout', `Timeout waiting ${read_timeout}ms for response from mstream.`))
        }, read_timeout)

        const on_readable = () => {
            clearTimeout(timer)
            dbgclog(`_read_response(): about to read.`)
            let reply = this.mstream.read()
            dbgclog(`_read_response(): after read. mstream.readableLength=${this.mstream.readableLength}. got data=${util.inspect(reply)}`)
            if (reply) {
                cb_once(null, reply)
            }
        }

        const on_error = (err) => {
            clearTimeout(timer)
            cb_once(err || new CMilterError('protocol', `Peer closed the connection while waiting for response from it.`))
        }

        if (this.mstream.readableLength > 0) {
            on_readable()
        } else {
            this.mstream.on('readable', on_readable)
                        .once('error', on_error)
                        .once('close', on_error)
        }
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    dbg(cmd_code, txt) {
        this.logdebug(`{${cmd_code.toUpperCase()}} ${txt}`)
    }

    get want_header_leading_space () { return this._features.includes('HDR_LEADSPC') }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    set error_state (flag) {
        if (this._error === flag) return
        this._error = flag
        if (this.mstream.writable) {
            this.mstream.destroy(new Error('upstream requested destruction'))
        }
        this.loginfo(`cmilter is ${flag ? 'NOW in' : 'NO longer in'} ERROR state`)
    }
}

// ---------------------------------------------------------------------------
class MilterStream extends stream.Duplex { // milter socket decorator
    constructor ({log, config}) {
        super({objectMode: true, autoDestroy: true})

        this.config = config
        this._readingPaused = false

        this._consume_it_myself = null

        this.setup_logging(log)

        this._sock = new net.Socket()
        this.attach_socket_events()

        log.debug(`MilterStream() inited`)
    }

    setup_logging (log) {
        this.log = {}
        for (const lvl in log) {
            this.log[lvl] = (msg) => log[lvl](`⦑mstream⦒ ${msg}`)
        }
    }

    attach_socket_events (sock) {
        this._sock
            .on('connect', () => this.emit('connect'))
            .on('drain', () => this.emit('drain'))
            .on('lookup', (err, address, family, host) => this.emit('lookup', err, address, family, host))
            .on('ready', () => {
                dbgmlog(`msock: ready!`)
                this.emit('ready')
            })

            .on('error', (e) => {
                this.error_state = true
                this.destroy(e)
                this.log.error(`msock: socket error: ${e}`)
                this.emit('error', e)
            })
            .on('end', () => {
                dbgmlog('msock: end event')
                if (this._sock.writable) {
                    this._sock.end()
                }
                this.emit('end')
            })
            // .on('data', socketOnData)
            .on('close', had_error => {
                dbgmlog(`conn closed. had_error: ${had_error}`)
                this.emit('close', had_error)
            })
            .on('timeout', () => {
                this.log.warn(`socket got a timeout event`)
                this.emit('timeout')
            })
            .on('readable', this._on_wire_readable.bind(this))

       	// function socketOnData (data) {
       	// 	debuglog('socketOnData: %d', data.length)
       	// }
    }

    _attach_on_wire_readable () {
        this._sock.on('readable', this._on_wire_readable.bind(this))
    }
    _detach_on_wire_readable () {
        this._sock.off('readable', this._on_wire_readable.bind(this))
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    connect (cb) {
        const copts = this.config.connection
        this.dbg('sconnnect', `connecting to ${util.inspect(copts)}`)

        if (this.in_error) cb(new CMilterError('stream', `stream is in error state, can't [re]connect`))

        const on_connect_error = (err) => {
            dbgclog(`{sconnnect} in conn_err_handler()`)
            this.error_state = true
            cb(new CMilterError('stream', 'connection error'))
        }

        const on_connected = async () => {
            this.dbg('sconnect', `connected to ${util.inspect(copts)}`)
            this._sock.off('error', on_connect_error)
                .setTimeout(0)

            this._connected = true
            cb()
        }

        this._sock
            .once('connect', on_connected)
            .once('error', on_connect_error)
            .setTimeout(this.config.timeouts.connection || 1000, () => {
                this.log.error(`connection timeout to ${util.inspect(copts)}`)
                on_connect_error()
            })

        this._sock.connect(copts)
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    _write ({cmd, data, expect_response}, enc, cb) {
        // type check
        const reject_it = () => cb(new CMilterError('argument', `invalid cmd argument supplied: ${cmd}`))
        if (typeof cmd === 'string') {
            var cmd_char = cmd.length > 1 ? mconsts.SMFIC[cmd] : cmd
            if (cmd_char === undefined || cmd_char.length !== 1) return reject_it()
        } else {
            return reject_it()
        }

        const doit = () => {
            if (data && data.constructor.name === 'MessageStream') {
                this._write_multi_command({cmd, cmd_char, data, expect_response}, enc, cb)
            } else {
                this._write_command({cmd, cmd_char, data, expect_response}, enc, cb)
            }
        }
        // ensure it's connected
        if (!this._connected) {
            return this.connect(err => {
                if (err) return cb(err)
                doit()
            })
        }
        doit()
    }

    _write_command ({cmd, cmd_char, data}, enc, cb) {
    	let dbuf
        dbgmlog('[%s] write_command called', cmd)

        if (typeof data === 'string') {
            // strings are null-terminated
            dbuf = Buffer.allocUnsafe(data.length + 1)
            dbuf.write(data)
            dbuf.writeUInt8(0, data.length)
        } else if (Buffer.isBuffer(data)) {
            dbuf = data
        } else {
            dbuf = Buffer.alloc(0)
        }

        dbgmlog('[%s] dbuf ready. len=%d. cmd_char=%s', cmd, dbuf.length, cmd_char)
        dbgmlog(hexit(dbuf))

        if (dbuf.length > mconsts.MILTER_CHUNK_SIZE) {
            return cb(CMilterError('max_size', `max command data size exceeded. `))
        }

        const buf = Mcoder.cmd_encode({cmd_char, data_buf: dbuf})

        // debuglog('[%s] about to wire full packet. len=%d', cmd, buf.length)
        // debuglog(hexit(buf))

        this._sock.write(buf, cb)
    }

    _write_multi_command ({cmd, cmd_char, data, expect_response}, enc, done) {
        dbgmlog('[%s] _write_multi_command called, body stream offset=%d', cmd, data.idx.body.start)
        if (!expect_response) {
            dbgmlog(`_write_multi_command: configured/negotiated to skip expecting a reply on ${cmd}.`)
        }

        // const offsetstream = new mutils.OffsetStream({offset: data.idx.body.start})

        let last_reply

        const chunker = new mutils.ChunkerStream({
            craft_header: (len) => Mcoder.cmd_len_encode(cmd_char, len),
            chunk_size: mconsts.MILTER_CHUNK_SIZE,
            controlled: expect_response
        })
        log_stream_events(chunker, 'CS user', dbgmlog)

        const done_once = mutils.once((err) => {
            chunker.removeAllListeners()
            this._consume_it_myself = null
            if (err) return done(err)

            if (!expect_response) return done()
            if (!last_reply) return done(new Error('badstate: no reply from milter, this is bad'))

            this.push(last_reply) // prematurely emit last milter reply
            done()
        }, this)

        // ** Mind twister ahead! **
        // todo: maybe move timeout code up the ladder to Cmilter (as is done in `_read_response`)
        const create_mutex = () => {
            const read_timeout = this.config.timeouts.body || 1000
            let timer_handle

            return Promise.race([
                new Promise(resolve => this._consume_it_myself = resolve),
                new Promise((_, reject) => {
                    timer_handle = setTimeout(() => reject(new CMilterError('timeout',
                                    `Timeout waiting ${read_timeout}ms for BODY cmd ack from mstream.`)),
                                    read_timeout)
                })
            ]).then(value => { clearTimeout(timer_handle); return value })
        }
        let reader_mutex = create_mutex()

        const unsnubber = async (ok) => {
            dbgmlog(`CS user: got snubbed event. awaiting unsnub...`)
            try {
                const reply = await reader_mutex
                dbgmlog(`_write_multi_command/unsnubber: got unsnub reply: ${util.inspect(reply)}`)
                if (reply.cmd_name !== 'CONTINUE') {
                    chunker.destroy(reply)
                }
                ok()
                reader_mutex = create_mutex()
            } catch (err) {
                ok(err)
            }
        }

        chunker
            .on('snubbed', unsnubber)
            .on('end', async (arg) => {
                if (expect_response) {
                    try {
                        last_reply = await reader_mutex
                    } catch (err) {
                        return done_once(err)
                    }
                    dbgmlog(`_write_multi_command/CS.onend: got reply: ${util.inspect(last_reply)}`)
                }
                done_once()
            })
            .on('error', (err) => {
                dbgmlog(`_write_multi_command: chunker in error state, passing out`)
                done_once(err)
            })

        data.pipe(chunker, {skip_headers: true}).pipe(this._sock, {end: false})
    }

    _read (rec_count) {
        this._readingPaused = false
        dbgmlog(`msock: _read() received`)
        setImmediate(() => this._read_from_wire(rec_count))
    }

    _on_wire_readable (rec_count) {
        dbgmlog(`msock: 'readable' event received`)

        this._read_from_wire(rec_count)
    }

    _read_from_wire (rec_count) {
        while (!this._readingPaused) {
            dbgmlog(`msock: _read_from_wire(${rec_count}): sock has ${this._sock.readableLength} bytes in buffer`)

            // read forthcoming packet length
            const len_buf = this._sock.read(mconsts.MILTER_LEN_BYTES) // uint32(len)
            if (!len_buf) return

            const len = len_buf.readUInt32BE()
            if (len < 1 || len > mconsts.MILTER_CHUNK_SIZE) {
                this.destroy(new CMilterError('max_size', `max command data size exceeded. decoded len=${len}`))
                return
            }

            // read that much data
            const buf = this._sock.read(len)
            dbgmlog(`_read_from_wire(): read ${buf.length} bytes from socket, requested=${len}`)

            // not enough data
            if (!buf) {
                dbgmlog(`_read_from_wire(): not enough data in the socket, unshifting len back and pausing wire`)
                this._sock.unshift(len_buf) // put len back
                // this._attach_on_wire_readable() // listen on wire for additional data
                return
            }

            if (buf.length !== len) { // dead socket spitting out remnants of data
                dbgmlog(`_read_from_wire(): data spitout, bad`)
                this.destroy(new CMilterError('deadsock', `socket excreted ${buf.length} bytes, destroying.`))
                return
            }

            const cmd_obj = this._parse_command(buf)
            if (!cmd_obj) {
                this.destroy(new CMilterError('cmd_decoder', `can't decode wire data`))
                return
            }

            if (cmd_obj.cmd_name === 'PROGRESS') {
                dbgmlog(`_read_from_wire(): got SMFIR_PROGRESS, silently consuming`)
                return
            }

            if (this._consume_it_myself) { // special case where we consume the data ourselves (BODY multi-cmd handling)
                return this._consume_it_myself(cmd_obj)
            }

            if (!this.push(cmd_obj)) {
                dbgmlog(`_read_from_wire(): tried to push to queue, but it's FULL: obj=${util.inspect(cmd_obj)}`)
                this._readingPaused = true // pause if consumer is stalled
            } else {
                dbgmlog(`_read_from_wire(): pushed to queue: obj=${util.inspect(cmd_obj)}`)
            }
        }
    }

    _parse_command (buf) {
        dbgmlog('_parse_command: about to parse command from buf: ' + hexit(buf))

        const cmd_name = mconsts.get_const_name('SMFIR', String.fromCharCode(buf[0]))
        if (undefined === cmd_name) {
            this.log.error(`wire read: can't parse cmd_code`)
            return
        }

        const data = buf.slice(1)
        return {cmd_name, data}
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    _final (cb) {
        dbgmlog(`_final: asked to close MilterStream`)
        this._sock.end(cb)
    }

    _destroy (err, cb) {
        dbgmlog(`_destroy: err=${err}`)
        this._sock.destroy()
        cb(err)
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    set error_state (flag) {
        if (this._error !== flag) return
        this._error = flag
        if (flag) this.log.info(`MilterStream now in ERROR state`)
    }

    get in_error () { return this._error }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
    dbg(code, txt) {
        this.log.debug(`<(${code.toUpperCase()})> ${txt}`)
    }
}

// ---------------------------------------------------------------------------
// attach event loggers
function log_stream_events (stream, name, dbglog) {
    const events = [
        'close',
        'drain',
        'finish',
        'pipe',
        'unpipe',
        'end',
        'pause',
        'resume'
    ]

    for (const evtype of events) {
        stream.on(evtype, () => dbglog(`${name}: '${evtype}' event`))
    }
    stream.on('error', (err) => dbglog(`${name}: 'error' event: ${util.inspect(err)}`))
}

exports.mlog = function (mcfg, connection, txt) {
    connection.logdebug(this, `(${mcfg.name}) ${txt}`)
}

exports.CMilter = CMilter
