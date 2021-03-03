'use strict'

const mconsts = require('./lib/constants')
const constants = require('haraka-constants')
const net = require('net')
const util = require('util')
const EventEmitter = require('events');
const {getKeyByValue} = require('./lib/utils')
const {CMilter} = require('./lib/cmilter')

const DEFAULT_MILTER_PORT = 7777

// HK hook name => milter command code name
const HK_MILTER_CMD_MAP = {
    connect: 'CONNECT',
    helo: 'HELO',
    ehlo: 'HELO',
    mail: 'MAIL',
    rcpt: 'RCPT',
    data:   'DATA',
    // data_post: 'HEADER',
    // disconnect: 'QUIT'
}

exports.register = function () {
    this.cfg = {}
    if (!this.load_config()) throw new Error('error loading config')

    if (this.cfg.defer_till !== 'eob') {
        for (const hook_name of Object.keys(HK_MILTER_CMD_MAP)) {
            this.register_hook(hook_name, 'hook_dispatcher', this.cfg.hooks_prio)
        }
    }

    this.register_hook('data_post',     'onDataPost',   this.cfg.hooks_prio)
    this.register_hook('disconnect',    'onDisconnect', this.cfg.hooks_prio)
}

exports.load_config = function () {
    const milters = []
    const main_cfg = this.config.get('milter.yaml', () => this.load_config())

    for (const mname of Object.keys(main_cfg.milters)) {
        const milcfg = {name: mname}
        const mcfg = main_cfg.milters[mname]
        try {
            Object.assign(milcfg, {
                connection: parse_conn_info(mcfg.connection),
                handlers:   parse_handlers_info(mcfg.handlers),
                timeouts:   mcfg.timeouts || {},
                actions:    parse_list_to_union(mcfg.negotiate_actions, mconsts.SMFIF),
                features:   parse_list_to_union(mcfg.negotiate_protocol_features, mconsts.SMFIP),
                skip:       mcfg.skip || {},
                macros:     mcfg.send_macros || false,
            })
        } catch (exc) {
            this.logerror(`{${mname}} parse error, aborting config [re]load. ${exc}`)
            return
        }
        milters.push(milcfg)
    }
    if (milters.length < 1) {
        this.logerror('aborting config [re]load. no milters were configured')
        return
    }
    this.cfg.milters = milters
    this.cfg.hooks_prio = main_cfg.prio || 0
    this.cfg.defer_till = main_cfg.defer_till
    return true
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
// dispatch incoming hooks to their corresponding milter commands
exports.hook_dispatcher = async function (next, connection, ...params) {
    try {
        const cmd_name = HK_MILTER_CMD_MAP[connection.hook]
        if (await this._for_each_milter_with_skipper(async (mcfg) => {
            // create cmilter map on first interaction
            if (!util.isObject(connection.notes.cmilters)) connection.notes.cmilters = {}

            // queue deferred commands at the start of connection (if not already queued)
            if (mcfg.defer && !connection.notes.cmilters[mcfg.name]) {
                for (const mcmd of mconsts.DEFERRED_COMMANDS) {
                    if (await this._wrap_milter_command(next, connection, mcfg, mcmd)) return true
                }
            }

            if (await this._wrap_milter_command(next, connection, mcfg, cmd_name, params)) return true
        }, connection, cmd_name)) return
    } catch (exc) {
        connection.logerror(this, exc)
    }
    next()
}

exports.onDataPost = async function (next, connection) {
    const trans = connection.transaction
    try {
        this._regen_auth_header(connection)

        if (this.cfg.defer_till === 'eob') { // invoke milters in series
            if (await this._for_each_milter_with_skipper(async (mcfg) => {
                    // if not sent earlier in previous transaction
                    if (!(connection.notes.cmilters && connection.notes.cmilters[mcfg.name])) {
                        for (const mcmd of mconsts.DEFERRED_COMMANDS) { // send CONNECT, HELO
                            if (await this._wrap_milter_command(next, connection, mcfg, mcmd)) return true
                        }
                    }

                    if (await this._wrap_milter_command(next, connection, mcfg,
                        'MAIL', [trans.mail_from])
                    ) return true

                    for (const rcpt of trans.rcpt_to) {
                        if (await this._wrap_milter_command(next, connection, mcfg,
                            'RCPT', [rcpt])
                        ) return true
                    }

                    if (await this._wrap_milter_command(next, connection, mcfg, 'DATA')) return true


                    if (await for_each_header(trans, async (name, value) =>
                            await this._wrap_milter_command(next, connection, mcfg, 'HEADER', {name, value}))
                    ) return

                    if (await this._wrap_milter_command(next, connection, mcfg, 'EOH')) return true

                    if (await this._wrap_milter_command(next, connection, mcfg, 'BODY', {message_stream: trans.message_stream})) return true

                    if (await this._wrap_milter_command(next, connection, mcfg, 'BODYEOB')) return true

                },
                connection
            )) return

        } else { // invoke milters in parallel

            let cmd_name = 'HEADER'
            if (await this._for_each_milter_with_skipper(async (mcfg) =>
                    await for_each_header(
                        connection.transaction,
                        async (name, value) =>
                            await this._wrap_milter_command(next, connection, mcfg, cmd_name, {name, value}),
                    ),
                connection,
                cmd_name
            )) return

            cmd_name = 'EOH'
            if (await this._for_each_milter_with_skipper(async (mcfg) => await this._wrap_milter_command(next, connection, mcfg, cmd_name), connection, cmd_name)) return

            cmd_name = 'BODY'
            if (await this._for_each_milter_with_skipper(async (mcfg) =>
                await this._wrap_milter_command(next, connection, mcfg, cmd_name, {message_stream: connection.transaction.message_stream}), connection, cmd_name
            )) return

            cmd_name = 'BODYEOB'
            if (await this._for_each_milter_with_skipper(async (mcfg) => await this._wrap_milter_command(next, connection, mcfg, cmd_name), connection, cmd_name)) return
        }

        next()
    } catch (exc) {
        console.error(exc)
        next(CONT, `onDataPost error: ${exc}`)
    }
}

exports.onDisconnect = async function (next, connection) {
    try {
        const cmd_name = 'QUIT'
        await this._for_each_milter_with_skipper(async (mcfg) => {
            /*await */ connection.notes.cmilters[mcfg.name].phase(cmd_name) // don't wait for connection teardown
        }, connection, cmd_name)
    } catch (exc) {
        connection.logerror(this, exc)
    }
    next()
}

// iterate through each milter config and invoke skipper code and wrap cb code
// @param   {Function}  cb  Called with `mcfg` argument. On `true` return, return out with `true`.
// @returns {Boolean}   true: stop further processing
exports._for_each_milter_with_skipper = async function (cb, connection, cmd_name) {
    for (const mcfg of this.cfg.milters) {
        const why_skip = this.should_skip(mcfg, connection, cmd_name)
        if (why_skip) {
            this.mlog(mcfg, connection, `skipping hook <${connection.hook}> because: ${why_skip}`)
            continue // return next(CONT, why_skip)
        }

        if (await cb.call(this, mcfg)) return true
    }
}

// wrapper for `_process_milter_command` AKA the command outcome handler
// @returns {Boolean}   true: stop further processing because disruptive action was implied by milter command
exports._wrap_milter_command = async function (cb, connection, mcfg, cmd_name, params) {
    const trans = connection.transaction
    const action = await this._process_milter_command(mcfg, connection, cmd_name, params)

    this.mlog(mcfg, connection, `got reply from _process_milter_command(${cmd_name}): ${util.inspect(action, {compact: true, breakLength: 200})}`)

    // store milter disposition reply in Results obj
    if (cmd_name === 'BODYEOB') this._store_outcome_to_results(mcfg, connection, action)

    if (action.code !== constants.cont) {
        this.mlog(mcfg, connection, `skipping further milters processing because action != CONT`)
        // (trans || connection).results.add(this, {fail: `${mcfg.name}(${cmd_name}:${action.msg})`})
        const msg = `${action.msg || `${action.milter_reply.code} action requested by milter ${mcfg.name}`} ` +
            `(${connection.transaction ? connection.transaction.uuid : connection.uuid})`
        cb(action.code, msg)
        return true // ask to stop processing
    }
}

// Call `cmilter.phase()` and handle its response according to "handlers response actions" config map
// returns {code: CONT|DENY|etc, msg: String}
exports._process_milter_command = async function (mcfg, connection, cmd_name, params) {
    this.mlog(mcfg, connection, `-> Processing command ${cmd_name}`)

    // create cmilter obj on first interaction
    if (!util.isObject(connection.notes.cmilters)) connection.notes.cmilters = {}
    let cmilter = connection.notes.cmilters[mcfg.name]
    if (!cmilter) {
        cmilter = connection.notes.cmilters[mcfg.name] = new CMilter({config: mcfg, connection})
        await cmilter.phase('OPTNEG')
    }
    if (mcfg.macros && mconsts.SWITCHBOX_STATES[cmd_name].allows_macro) {
        var resp = await cmilter.phase('MACRO', {cmdcode: mconsts.SMFIC[cmd_name], kvlist: this._populate_macro_kvlist(connection, cmd_name, params)})
    }

    resp = await cmilter.phase(cmd_name, params)

    const outcome = this._handle_cmilter_response(mcfg, resp)
    outcome.milter_reply = resp

    this.mlog(mcfg, connection, `<- got cmilter response code=${resp.code}, which translated to HK code ${constants.translate(outcome['code'])}` +
                                (resp.msg ? ` ✹ msg=${resp.msg}` : ''))

    if (resp.modactions) { // cmilter responded with modactions list
        const reply = this._process_milter_actions(mcfg, connection, resp.modactions)

        const modactions_outcome = this._handle_cmilter_response(mcfg, reply)

        if (outcome.code === constants.cont) { // disposition action is a "safe" one
            Object.assign(outcome, modactions_outcome)
        } else { // disposition action is a "bad" one, just copy the modaction msg then
            if (!outcome.msg) outcome.msg = modactions_outcome.msg
        }
    }
    return outcome
}

// act upon "modification actions"
exports._process_milter_actions = function (mcfg, connection, actions) {
    this.mlog(mcfg, connection, `got actions: ${util.inspect(actions, {compact: true, depth: 3, breakLength: 200})}`)
    let response
    for (const action of actions) {
        switch (action.type) {
            case 'ADDHEADER':
                this._add_header(connection, {header: action.header, where: 'append'})
                break
            case 'INSHEADER':
                this._add_header(connection, {header: action.header, where: 'prepend'})
                break
            case 'CHGHEADER':
                this._change_header(connection, action.header)
                break
            case 'QUARANTINE':
                response = {code: 'quarantine', reason: action.reason}
                connection.transaction.results.add(this, {fail: `${mcfg.name}(QUARANTINE:${action.reason})`, msg: `${mcfg.name}(${action.reason})`})
                break
            case 'REPLBODY':
                // this._change_body(connection, buf)
            default:
                throw new Error('not implemented')
        }
    }
    return response
}

exports._handle_cmilter_response = function (mcfg, cmilter_reply) {
    const outcome = {code: constants.cont}
    if (cmilter_reply && cmilter_reply.code) {

        const hk_code = mcfg.handlers[cmilter_reply.code]
        if (hk_code !== undefined) {
            if (util.isObject(hk_code) && cmilter_reply.smtpcode) {
                const hkcode2 = hk_code[cmilter_reply.smtpcode]
                if (hkcode2) outcome['code'] = hkcode2
            } else {
                outcome['code'] = hk_code
            }
        }
        if (cmilter_reply.msg) {
            outcome['msg'] = cmilter_reply.msg
        } else if (cmilter_reply.reason) {
            outcome['msg'] = cmilter_reply.reason
        }
    }
    return outcome
}

exports._populate_macro_kvlist = function (connection, cmd_name, params) {
    const kvlist = {}
    switch (cmd_name) {
        case 'CONNECT':
            return { // $_ $j ${daemon_name} ${if_name} ${if_addr}
                _: connection.remote.host,
                j: connection.local.host,
                '{daemon_name}': 'HK',
                '{if_name}': connection.local.host,
                '{if_addr}': connection.local.ip,
            }
        case 'HELO':
            return { // ${tls_version} ${cipher} ${cipher_bits} ${cert_subject} ${cert_issuer}
            }
        case 'MAIL':
            let o = { // $i ${auth_type} ${auth_authen} ${auth_ssf} ${auth_author} ${mail_mailer} ${mail_host} ${mail_addr}
                'i': connection.transaction ? connection.transaction.uuid : connection.uuid,
                '{mail_host}': connection.transaction.mail_from.host,
                '{mail_addr}': connection.transaction.mail_from.user,
            }
            if (connection.notes.auth_user) {
                o['{auth_type}'] = connection.notes.auth_method
                o['{auth_authen}'] = connection.notes.auth_user
            }
            return o
        case 'RCPT':
            return { // ${rcpt_mailer} ${rcpt_host} ${rcpt_addr}
                '{rcpt_host}': params[0].host,
                '{rcpt_addr}': params[0].user,
            }
    }
}

exports._change_header = function (connection, header) {
    const hdr = connection.transaction.header

    if (hdr.headers.hasOwnProperty(header.name.toLowerCase())) {
        connection.loginfo(this, `about to ${header.value.length > 0 ? 'change' : 'remove'} header ${header.name} at index ${header.index}`)
        const orig_header_values = hdr.get_all(header.name)
        connection.transaction.remove_header(header.name)
        if (!orig_header_values[header.index]) {
            connection.loginfo(this, `_change_header: couldn't find header ${header.name} index ${header.index}`)
            return false
        }
        if (header.value.length > 0) {
            orig_header_values[header.index] = header.value
        } else {
            orig_header_values.splice(header.index, 1)
        }
        for (const orig_val of orig_header_values) {
            connection.transaction.add_header(header.name, orig_val)
        }
    } else {
        connection.loginfo(this, `asked to change a header that doesn't exist: ${header.name}`)
        return false
    }
    return true
}

exports._change_body = function (connection, buf) {
    // connection.logerror(this, `not implemented`)
}

exports._add_header = function (connection, {header, where}) {
    connection.transaction[where === 'append' ? 'add_header' : 'add_leading_header'](header.name, header.value)
    // handle special cases
    if (header.name === 'Authentication-Results') {
        // assume we are the authserv-id, so just strip it
        const resinfo = header.value.substring(header.value.indexOf(';') + 2).replace(/[\r\n\t]+/g, ' ').trim()
        this._regen_auth_header(connection, resinfo)
        connection.loginfo(this, `have set auth_results(${resinfo}) and regenerated the header`)
    }
}

exports._store_outcome_to_results = function (mcfg, connection, {milter_reply}) {
    this.mlog(mcfg, connection, `EOM: action: ${util.inspect(milter_reply, {compact: true, depth: 3, breakLength: 200})}`)
    const trans = connection.transaction
    const outcome_obj = {action: milter_reply.code}

    if (['ACCEPT', 'CONTINUE'].includes(milter_reply.code)) {
        trans.results.add(this, {pass: `${mcfg.name}(${milter_reply.code})`})
    } else if (['REJECT', 'DISCARD', 'ABORT'].includes(milter_reply.code)) {
        trans.results.add(this, {fail: `${mcfg.name}(${milter_reply.code})`})
    } else if ('REPLYCODE' === milter_reply.code) {
        trans.results.add(this, {fail: `${mcfg.name}(${milter_reply.code}:${milter_reply.reason})`, msg: `${mcfg.name}(${milter_reply.reason})`})
        outcome_obj['msg'] = milter_reply.reason
        outcome_obj['smtpcode'] = milter_reply.smtpcode
    }

    trans.results.add(this, {[mcfg.name]: outcome_obj})
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
exports.should_skip = function (mcfg, connection, command_code) {
    if (connection.notes.milter_skip) return 'skip:earlier'

    if (this.cfg.defer_till === 'transaction' && mconsts.DEFERRED_COMMANDS.includes(command_code)) {
        connection.notes.milter_deferred = true
        return 'deferred_command'
    }

    const why_skipped = this.should_skip_when_special_state(mcfg, connection)
    if (why_skipped) {
        connection.results.add(this, {skip: why_skipped})
        connection.notes.milter_skip = true
        return `config:${why_skipped}`
    }
}

exports.should_skip_when_special_state = function (mcfg, connection) {
    if (mcfg.skip.authenticated === true && connection.notes.auth_user)
        return 'authed'

    if (mcfg.skip.relay === true && connection.relaying)
        return 'relay'

    if (mcfg.skip.local_ip === true && connection.remote.is_local)
        return 'local_ip'

    if (mcfg.skip.private_ip === true && connection.remote.is_private && !(mcfg.skip.local_ip === false && connection.remote.is_local))
        return 'private_ip'

    return false
}

exports.for_each_milter = function (cb) {
    return this.cfg.milters.forEach(cb)
}

exports._regen_auth_header = function (connection, resinfo) {
    const ar = connection.auth_results(resinfo)
    if (ar) {
        connection.transaction.remove_header('Authentication-Results')
        connection.transaction.add_leading_header('Authentication-Results', connection.auth_results())
    }
}

exports.mlog = function (mcfg, connection, txt) {
    connection.logdebug(this, `(${mcfg.name}) ${txt}`)
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
//
// config parsers/validators
//
function parse_conn_info (ci) {
    if ('socket' in ci) {
        return {socket: ci.socket}
    } else if ('host' in ci) {
        return {host: ci.host, port: ci.port || DEFAULT_MILTER_PORT}
    } else {
        throw new Error('no connection info supplied')
    }
/*    let matches
    if (str.match(/^\//)) {
        // assume unix socket
        cfg['socket'] = str
    } else if ((matches = str.match(/^\[([^\] ]+)\](?::(\d+))?/))) {
        // IPv6 literal
        cfg['inet'] = {host: matches[1]}
        if (matches[2] !== undefined) cfg['inet']['port'] = matches[2]
    } else {
        const hostport = host.split(/:/);
        cfg['inet'] = {host: hostport[0]}
        if (hostport[1] !== undefined) cfg['inet']['port'] = hostport[0]
    }*/
}

function parse_handlers_info (hcfg) {
    const handlers = ['reject', 'quarantine', 'tempfail']
    if (!util.isObject(hcfg)) throw new Error('no handlers info supplied')
    const cfg = {}
    for (let hname of handlers) {
        if (hname in hcfg) {
            if (hcfg[hname] in constants) {
                cfg[hname.toUpperCase()] = constants[hcfg[hname]]
            } else {
                throw new Error(`unknown/invalid "${hname}" handler haraka constant was supplied`)
            }
        } else {
            cfg[hname.toUpperCase()] = constants.cont
        }
    }
    if ('replycode' in hcfg) {
        cfg['REPLYCODE'] = {}
        for (const [smtpcode, constname] of Object.entries(hcfg['replycode'])) {
            if (constname in constants) {
                cfg['REPLYCODE'][smtpcode] = constants[constname]
            } else {
                throw new Error(`unknown/invalid "${constname}" handler haraka constant was supplied`)
            }
        }
    }
    return cfg
}

function parse_list_to_union (list, mapping) {
    if (!util.isArray(list) || list.length < 1) return {list: [], union: 0}

    const flist = []
    let union = 0
    for (let aname of list) {
        aname = aname.toUpperCase()
        if (!(aname in mapping)) {
            throw new Error(`unknown/invalid "${aname}" option was supplied`)
        }
        flist.push(aname)
        union |= mapping[aname]
    }
    return {list: flist, union}
}

async function for_each_header(transaction, cb, want_leading_space = false) {
    for (const header of transaction.header.lines()) {
        const match = header.match(/^([^\s:]+):([\s\S]*?)(?:\r?\n)*$/)
        if (match) {
            if (await cb(match[1], match[2])) return true
        } else {
            throw new Error(`badcode: impossible header supplied: ${header}`)
        }
    }
}