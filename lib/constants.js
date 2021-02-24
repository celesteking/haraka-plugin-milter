
const {getKeyByValue} = require('./utils')

exports.SMFI_VERSION = 6
exports.SMFI_MIN_VERSION = 2
module.exports.MILTER_VERSION = 0x01000002;

module.exports.MI_SUCCESS = 0;
module.exports.MI_FAILURE = -1;

module.exports.MILTER_LEN_BYTES = 4;
module.exports.MILTER_CHUNK_SIZE = 65535;

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// set in OPTNEG "actions" field
exports.SMFIF = {
	NONE:			0x00000000,	// no flags
	ADDHDRS:		0x00000001,	// filter may add headers
	CHGBODY:		0x00000002,	// filter may replace body
	MODBODY:		0x00000002,	// backwards compatible
	ADDRCPT:		0x00000004,	// filter may add recipients
	DELRCPT:		0x00000008,	// filter may delete recipients
	CHGHDRS:		0x00000010,	// filter may change/delete headers
	QUARANTINE:		0x00000020,	// filter may quarantine envelope

	/* filter may change "from" (envelope sender) */
	CHGFROM:		0x00000040,
	ADDRCPT_PAR:		0x00000080,	/* add recipients incl. args */

	/* filter can send set of symbols (macros) that it wants */
	SETSYMLIST:		0x00000100
}

// What the MTA can send/filter wants in protocol
// set in OPTNEG "protocol" field
exports.SMFIP = {
	NOCONNECT:		0x00000001,	// MTA should not send connect info
	NOHELO:			0x00000002,	// MTA should not send HELO info
	NOMAIL:			0x00000004,	// MTA should not send MAIL info
	NORCPT:			0x00000008,	// MTA should not send RCPT info
	NOBODY:			0x00000010,	// MTA should not send body
	NOHDRS:			0x00000020,	// MTA should not send headers
	NOEOH:			0x00000040,	// MTA should not send EOH
	NR_HDR:			0x00000080,	// No reply for headers
	NOHREPL:		0x00000080,	// No reply for headers
	NOUNKNOWN:		0x00000100, // MTA should not send unknown commands
	NODATA:			0x00000200,	// MTA should not send DATA
	SKIP:			0x00000400,	// MTA understands SMFIS.SKIP
	RCPT_REJ:		0x00000800, // MTA should also send rejected RCPTs
	NR_CONN:		0x00001000,	// No reply for connect
	NR_HELO:		0x00002000,	// No reply for HELO
	NR_MAIL:		0x00004000,	// No reply for MAIL
	NR_RCPT:		0x00008000,	// No reply for RCPT
	NR_DATA:		0x00010000,	// No reply for DATA
	NR_UNKN:		0x00020000,	// No reply for UNKN
	NR_EOH:			0x00040000,	// No reply for eoh
	NR_BODY:		0x00080000,	// No reply for body chunk
	HDR_LEADSPC:		0x00100000,	// header value leading space
	MDS_256K:		0x10000000,	// MILTER_MAX_DATA_SIZE=256K
	MDS_1M:			0x20000000	// MILTER_MAX_DATA_SIZE=1M
// 		0x40000000	reserved: see SMFI_INTERNAL
}

// command codes
exports.SMFIC  = {
	ABORT:		'A',	// Abort
	BODY:		'B',	// Body chunk
	CONNECT:	'C',	// Connection information
	MACRO:		'D',	// Define macro
	BODYEOB:	'E',	// final body chunk (End)
	HELO:		'H',	// HELO/EHLO
	QUIT_NC:	'K',	// QUIT but new connection follows
	HEADER:		'L',	// Header
	MAIL:		'M',	// MAIL from
	OPTNEG:		'O',	// Option negotiation
	EOH:		'N',	// EOH
	QUIT:		'Q',	// QUIT
	RCPT:		'R',	// RCPT to
	DATA:		'T',	// DATA
	UNKNOWN:	'U',	// Any unknown command
}

// response codes
exports.SMFIR = {
	ADDRCPT:		'+',	// add recipient
	DELRCPT:		'-',	// remove recipient
	ADDRCPT_PAR:	'2',	// add recipient (incl. ESMTP args)
	SHUTDOWN:		'4',	// 421: shutdown (internal to MTA)
	ACCEPT:			'a',	// accept
	REPLBODY:		'b',	// replace body (chunk)
	CONTINUE:		'c',	// continue
	DISCARD:		'd',	// discard
	CHGFROM:		'e',	// change envelope sender (from)
	CONN_FAIL:		'f',	// cause a connection failure
	ADDHEADER:		'h',	// add header
	INSHEADER:		'i',	// insert header
	SETSYMLIST:		'l',	// set list of symbols (macros)
	CHGHEADER:		'm',	// change header
	PROGRESS:		'p',	// progress
	QUARANTINE:		'q',	// quarantine
	REJECT:			'r',	// reject
	SKIP:			's',	// skip
	TEMPFAIL:		't',	// tempfail
	REPLYCODE:		'y',	// reply code etc

	// special
	OPTNEG:		    'O',	// Option negotiation
}

exports.MILTER_ACTIONS = {
	// modification actions
	MODIFICATION: [ 'ADDRCPT', 'DELRCPT', 'REPLBODY', 'ADDHEADER', 'CHGHEADER', 'INSHEADER', 'QUARANTINE', 'ABORT' ],
	// accept/reject actions
	DISPOSITION: [ 'ACCEPT', 'REJECT', 'TEMPFAIL', 'REPLYCODE', 'CONTINUE', 'DISCARD', 'ABORT' ],
}

// allowed switchbox state transitions
exports.SWITCHBOX_STATES = {
	OPTNEG:     { expect: ['OPTNEG'], next: ['MACRO', 'CONNECT', 'HELO', 'MAIL', 'RCPT', 'DATA', 'HEADER', /*'EOH',*/ 'BODY', 'BODYEOB', 'QUIT'] },
	CONNECT:    { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['MACRO', 'HELO', 'MAIL', 'RCPT', 'DATA', 'HEADER', 'BODY', 'BODYEOB', 'QUIT'], allows_macro: true },
	HELO:       { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['MACRO', 'MAIL', 'RCPT', 'DATA', 'HEADER', 'BODY', 'BODYEOB', 'QUIT'], allows_macro: false },
	MAIL:       { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['MACRO', 'RCPT', 'DATA', 'HEADER', 'BODY', 'BODYEOB', 'QUIT'], allows_macro: true },
	RCPT:       { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['MACRO', 'RCPT', 'DATA', 'HEADER', 'BODY', 'BODYEOB', 'QUIT'], allows_macro: true },
	DATA:       { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['HEADER', 'BODY', 'BODYEOB', 'QUIT'] },
	HEADER:     { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['HEADER', 'EOH', 'BODY', 'BODYEOB', 'QUIT'] },
	EOH:        { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['BODY', 'BODYEOB', 'QUIT'] },
	BODY:       { expect: exports.MILTER_ACTIONS.DISPOSITION, next: ['BODY', 'BODYEOB', 'QUIT'] },
	BODYEOB: {
		expect: [...exports.MILTER_ACTIONS.DISPOSITION, ...exports.MILTER_ACTIONS.MODIFICATION],
		next: ['MACRO', 'MAIL', 'QUIT']
	},
	MACRO:      { next: ['CONNECT', 'HELO', 'MAIL', 'RCPT'] },
	QUIT:       { },
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// Defer commands (SMFIC) until transaction (MAIL FROM) appears. Used when `defer_till: transaction` is set in config.
exports.DEFERRED_COMMANDS = [
	'CONNECT',
	'HELO',
]

// mapping of what commands (SMFIC) should be skipped
// SMFIP => SMFIC
exports.PROTO_CMD_SKIP_MAP = {
	NOCONNECT: 'CONNECT',
	NOHELO: 'HELO',
	NOMAIL: 'MAIL',
	NORCPT: 'RCPT',
	NOBODY: 'BODY',
	NOHDRS: 'HEADER',
	NOEOH: 'EOH',
	NODATA: 'DATA'
}

// mapping of what commands (SMFIC) should not be expected to be replied to
// SMFIP => SMFIC
exports.PROTO_REPLY_SKIP_MAP = {
	NR_HDR:     'HEADER',
	NR_CONN:    'CONNECT',
	NR_HELO:    'HELO',
	NR_MAIL:    'MAIL',
	NR_RCPT:    'RCPT',
	NR_DATA:    'DATA',
	NR_EOH:     'EOH',
	NR_BODY:    'BODY',
}
// Protocol families used with SMFIC_CONNECT in the "family" field:
exports.SMFIA = {
	UNKNOWN: 'U',   // Unknown (NOTE: Omits "port" and "host" fields entirely)
	UNIX: 'L',      // Unix (AF_UNIX/AF_LOCAL) socket ("port" is 0)
	INET: '4',      // TCPv4 connection
	INET6: '6',     // TCPv6 connection
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
module.exports.SMFIS = {
	CONTINUE:	0,
	REJECT:		1,
	DISCARD:	2,
	ACCEPT:		3,
	TEMPFAIL:	4,
	NOREPLY:	7,
	SKIP:		8,
	ALL_OPTS:	10,
	_KEEP:		20,
	_ABORT:		21,
	_OPTIONS:	22,
	_NOREPLY:	7, // SMFIS.NOREPLY,
	_FAIL:		-1,
	_NONE:		-2
};

/* states */
module.exports.ST = {
	NONE:	-1,
	INIT:	0,		// initial state
	OPTS:	1,		// option negotiation
	CONN:	2,		// connection info
	HELO:	3,		// helo
	MAIL:	4,		// mail from
	RCPT:	5,		// rcpt to
	DATA:	6,		// data
	HDRS:	7,		// headers
	EOHS:	8,		// end of headers
	BODY:	9,		// body
	ENDM:	10,		// end of message
	QUIT:	11,		// quit
	ABRT:	12,		// abort
	UNKN:	13,		// unknown SMTP command
	Q_NC:	14,		// quit, new connection follows
	SKIP:	16,		// not a state but required for the state table
};

module.exports.MAX_MACROS_ENTRIES = 7;

module.exports.SMFIM = {
	CONNECT:	0,	// connect
	HELO:		1,	// HELO/EHLO
	ENVFROM:	2,	// MAIL From
	ENVRCPT:	3,	// RCPT To
	DATA:		4,	// DATA
	EOM:		5,	// end of message (final dot)
	EOH:		6	// end of header
};

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

// whether `bit` is set in `word`
exports.is_bit_set = function(bit, word) {
	return (((word) & (bit)) !== 0);
}

// get const map key name by value
exports.get_const_name = (type, value) => {
	if (!type in exports) throw new Error(`supplied type ${type} not known`)
	return getKeyByValue(exports[type], value)
}

// "unwrap" const names from supplied value that has them OR'ed
exports.unfold_const_names = function (type, value) {
	if (!type in this) throw new Error(`supplied type ${type} not known`)
	const mapping = this[type]
	return Object.keys(mapping).filter((const_name) => this.is_bit_set(mapping[const_name], value))
}