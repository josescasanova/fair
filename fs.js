#!/usr/bin/env node

require('./utils')

// Defines promised/insured for both users based on insurance and delta=(ondelta+offdelta)
// There are 3 major scenarios of delta position
// . is 0, | is delta, = is insurance, - is promised
// 4,6  .====--| 
// 4,2  .==|==
// 4,-2 |--.====
resolveChannel = (insurance, delta, is_left=true) => {
  var parts = {
    // left user promises only with negative delta, scenario 3
    promised: delta < 0 ? -delta : 0,
    insured:      delta > insurance ? insurance : (delta > 0 ? delta             : 0),
    they_insured: delta > insurance ? 0         : (delta > 0 ? insurance - delta : insurance),
    // right user promises when delta goes beyond insurance, scenario 1
    they_promised: delta > insurance ? delta - insurance : 0
  }
  
  // default view is left. if current user is right, simply reverse
  if (!is_left) {
    [parts.promised, parts.insured, parts.they_insured, parts.they_promised] = 
    [parts.they_promised, parts.they_insured, parts.insured, parts.promised]
  }

  return parts
}

// Called once in a while to cache current state of everything and flush it to browser
// TODO: better way to keep app reactive?
cache = async (i) => {
  if (K) {
    cached_result.is_hub = me.is_hub ? me.my_member.hub.handle : false

    cached_result.my_member = !!me.my_member

    cached_result.K = K

    cached_result.current_db_hash = current_db_hash().toString('hex')


    cached_result.proposals = await Proposal.findAll({
      order: [['id', 'DESC']],
      include: {all: true}
    })

    cached_result.users = await User.findAll({include: {all: true}})
    cached_result.insurances = await Insurance.findAll({include: {all: true}})

    cached_result.blocks = (await Block.findAll({
      limit: 500,
      order: [['id', 'desc']], 
      where: {
        meta: {[Sequelize.Op.not]: null}
      }
    })).map(b=>{
      var [precommits, header, tx_body] = r(b.block)

      var [methodId,
        built_by,
        prev_hash,
        timestamp,
        ordered_tx] = r(header)

      return {
        id: b.id,
        prev_hash: toHex(b.prev_hash),
        hash: toHex(b.hash),
        built_by: readInt(built_by),
        timestamp: readInt(timestamp),
        meta: JSON.parse(b.meta),
        total_tx: b.total_tx
      }
    })


    if (me.is_hub) {
      var deltas = await Delta.findAll({where: {myId: me.record.id} })
      var promised = 0
      for (var d of deltas) {
        var ch = await me.channel(d.userId)
        if (ch.delta > 0) promised += ch.promised
      }

      if (cached_result.history[0] && cached_result.history[0].delta != promised) {
        cached_result.history.unshift({
          date: new Date(),
          delta: promised
        })
      }
    } else {
      cached_result.history = await History.findAll({
        order: [['id', 'desc']],
        include: {all: true}
      })
    }


  }


  // TODO: read hash just after snapshot generation 
  if (me.my_member && K.last_snapshot_height) {
    var filename = `Failsafe-${K.last_snapshot_height}.tar.gz`
    var cmd = 'shasum -a 256 private/' + filename

    require('child_process').exec(cmd, async (er, out, err) => {
      if (out.length == 0) {
        l('This state doesnt exist')
        return false
      }

      var out_hash = out.split(' ')[0]

      var our_location = me.my_member.location.indexOf(localhost) != -1 ? `http://${localhost}:8000/` : `https://failsafe.network/`

      cached_result.install_snippet = `id=fs
f=${filename}
mkdir $id && cd $id && curl ${our_location}$f -o $f
if [[ -x /usr/bin/sha256sum ]] && sha256sum $f || shasum -a 256 $f | grep \\
  ${out_hash}; then
  tar -xzf $f && rm $f && ./install
  node fs -p8001
fi
`
    })
  }
}


// Flush an object to browser websocket
react = async (result = {}, id = 1) => {
  await cache()

  if (me.id) {
    result.record = await me.byKey()

    result.username = me.username // just for welcome message

    result.pubkey = toHex(me.pubkey)

    result.invoices = invoices
    result.purchases = purchases

    result.pending_tx = PK.pending_tx

    result.channels = await me.channels()
  }

  if (me.browser) {
    me.browser.send(JSON.stringify({
      result: Object.assign(result, cached_result),
      id: id
    }))
  }
}

// TODO: Move from memory to persistent DB
cached_result = {
  history: []
}

invoices = {}
purchases = {}



initDashboard = async a => {
  var finalhandler = require('finalhandler')
  var serveStatic = require('serve-static')

  var cb = function (req, res) {
    if (req.url.match(/^\/Failsafe-([0-9]+)\.tar\.gz$/)) {
      var file = 'private' + req.url
      var stat = fs.statSync(file)
      res.writeHeader(200, {'Content-Length': stat.size})
      var fReadStream = fs.createReadStream(file)
      fReadStream.on('data', function (chunk) {
        if (!res.write(chunk)) {
          fReadStream.pause()
        }
      })
      fReadStream.on('end', function () {
        res.end()
      })
      res.on('drain', function () {
        fReadStream.resume()
      })
    } else if (req.url == '/rpc') {
      var queryData = ''
      req.on('data', function (data) { queryData += data })

      req.on('end', function () {
        me.queue.push(['internal_rpc', res, queryData])
      })
    } else {
      serveStatic('./wallet')(req, res, finalhandler(req, res))
    }
  }

  // this serves dashboard HTML page
  var on_server = fs.existsSync('/etc/letsencrypt/live/failsafe.network/fullchain.pem')

  if (on_server) {
    cert = {
      cert: fs.readFileSync('/etc/letsencrypt/live/failsafe.network/fullchain.pem'),
      key: fs.readFileSync('/etc/letsencrypt/live/failsafe.network/privkey.pem')
    }
    var server = require('https').createServer(cert, cb)

    // redirecting from http://
    if (base_port == 443) {
      require('http').createServer(function (req, res) {
        res.writeHead(301, { 'Location': 'https://' + req.headers['host'] })
        res.end()
      }).listen(80)
    }
  
  } else {
    cert = false
    var server = require('http').createServer(cb)
  }


  me = new Me()

  repl.context.me = me

  if (fs.existsSync('private/pk.json')) {
    PK = JSON.parse(fs.readFileSync('private/pk.json'))
  } else {
    // used to authenticate browser sessions to this daemon
    PK = {
      auth_code: toHex(crypto.randomBytes(32)),
      
      pending_tx: []
    }
  }


  var url = `http://${localhost}:${base_port}/#auth_code=${PK.auth_code}`
  l('Open ' + url + ' in your browser')
  server.listen(base_port).once('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      l('port is currently in use')
      process.exit()  
    }
  });
  
  // opn doesn't work in SSH console
  if (base_port != 443) opn(url)


  if (argv.username) {
    var seed = await derive(argv.username, argv.pw)
    await me.init(argv.username, seed)
    await me.start()
  } else if (PK.username) {
    await me.init(PK.username, Buffer.from(PK.seed, 'hex'))
    await me.start()
  }
  
  me.processQueue()


  localwss = new ws.Server({ server: server, maxPayload: 64 * 1024 * 1024 })

  localwss.on('error', function (err) { console.error(err) })
  localwss.on('connection', function (ws) {
    ws.on('message', (msg) => {
      me.queue.push(['internal_rpc', ws, msg])
    })
  })
}

derive = async (username, pw) => {
  return new Promise((resolve, reject) => {
    require('./lib/scrypt')(pw, username, {
      N: Math.pow(2, 12),
      r: 8,
      p: 1,
      dkLen: 32,
      encoding: 'binary'
    }, (r) => {
      r = bin(r)
      resolve(r)
    })

/* Native scrypt. TESTNET: we use pure JS scrypt
    var seed = await scrypt.hash(pw, {
      N: Math.pow(2, 16),
      interruptStep: 1000,
      p: 2,
      r: 8,
      dkLen: 32,
      encoding: 'binary'
    }, 32, username)

    return seed; */
  })
}

// On-Chain Database - every full node has exact same copy
var base_db = {
  dialect: 'sqlite',
  // dialectModulePath: 'sqlite3',
  storage: 'data/db.sqlite',
  define: {timestamps: false},
  operatorsAliases: false,
  logging: false
}

sequelize = new Sequelize('', '', 'password', base_db)


User = sequelize.define('user', {
  username: Sequelize.STRING,
  pubkey: Sequelize.CHAR(32).BINARY,
  nonce: Sequelize.INTEGER,
  balance: Sequelize.BIGINT // on-chain balance: mostly to pay taxes
})

User.idOrKey = async function (id) {
  if (id.length == 32) {
    return (await User.findOrBuild({
      where: {pubkey: id},
      defaults: {
        nonce:0,
        balance:0
      }
    }))[0]
  } else {
    return await User.findById(readInt(id))    
  }
}

User.prototype.payDebts = async function (parsed_tx) {
  var debts = await this.getDebts()

  for (var d of debts) {
    var u = await User.findById(d.oweTo)

    if (d.amount_left <= this.balance) {
      this.balance -= d.amount_left
      u.balance += d.amount_left

      parsed_tx.debts.push([d.amount_left, u.id])

      await u.save()
      await d.destroy()
    } else {
      d.amount_left -= this.balance
      u.balance += this.balance
      this.balance = 0 // this user is broke now!

      parsed_tx.debts.push([this.balance, u.id])

      await u.save()
      await d.save()
      break
    }
  }
}


Debt = sequelize.define('debt', {
  amount_left: Sequelize.INTEGER,
  oweTo: Sequelize.INTEGER
})


Debt.belongsTo(User)
User.hasMany(Debt)


Proposal = sequelize.define('proposal', {
  desc: Sequelize.TEXT,
  code: Sequelize.TEXT,
  patch: Sequelize.TEXT,

  delayed: Sequelize.INTEGER, //cron

  kindof: Sequelize.STRING
})

Insurance = sequelize.define('insurance', {
  leftId: Sequelize.INTEGER,
  rightId: Sequelize.INTEGER,

  nonce: Sequelize.INTEGER, // for instant withdrawals, increase one by one

  insurance: Sequelize.BIGINT, // insurance
  ondelta: Sequelize.BIGINT, // what hub already insuranceized

  dispute_delayed: Sequelize.INTEGER,

  // increased off-chain. When disputed, higher one is true
  dispute_nonce: Sequelize.INTEGER, 
  dispute_offdelta: Sequelize.INTEGER,

  // started by left user?
  dispute_left: Sequelize.BOOLEAN
})

Insurance.prototype.resolve = async function(){
  var resolved = resolveChannel(this.insurance, this.ondelta + this.dispute_offdelta, true)

  var left = await User.findById(this.leftId)
  var right = await User.findById(this.rightId)

  // to balance delta into 0
  this.ondelta = -this.dispute_offdelta

  // splitting insurance between users
  left.balance += resolved.insured
  right.balance += resolved.they_insured

  // anybody owes to anyone?
  if (resolved.promised > 0 || resolved.they_promised > 0) {
    var d = await Debt.create({
      userId: resolved.promised > 0 ? left.id : right.id,
      oweTo: resolved.promised > 0 ? right.id : left.id,
      amount_left: resolved.promised > 0 ? resolved.promised : resolved.they_promised
    })
  }

  await left.save()
  await right.save()

  this.insurance = 0
  this.dispute_delayed = null
  this.dispute_left = null
  this.dispute_nonce = null
  this.dispute_offdelta = null

  await this.save()

  var withUs = me.pubkey.equals(left.pubkey) ? right : (me.pubkey.equals(right.pubkey) ? left : false)

  // are we in this dispute? Unfreeze the channel
  if (withUs) {
    var ch = await me.channel(withUs.pubkey)
    // reset all credit limits - the relationship starts "from scratch"
    ch.d.soft_limit = 0
    ch.d.hard_limit = 0
    ch.d.they_soft_limit = 0
    ch.d.they_hard_limit = 0

    ch.d.status = 'ready'
    await ch.d.save()
  }
}

Vote = sequelize.define('vote', {
  rationale: Sequelize.TEXT,
  approval: Sequelize.BOOLEAN // approval or denial
})

Proposal.belongsTo(User)

// User.belongsToMany(User, {through: Insurance, as: 'left'})
// User.belongsToMany(User, {through: Insurance, as: 'right'})

Proposal.belongsToMany(User, {through: Vote, as: 'voters'})





// Off-Chain database - local and private stuff

if (!fs.existsSync('private')) fs.mkdirSync('private')

base_db.storage = 'private/db.sqlite'
privSequelize = new Sequelize('', '', 'password', base_db)

Block = privSequelize.define('block', {
  block: Sequelize.CHAR.BINARY,
  hash: Sequelize.CHAR(32).BINARY,
  prev_hash: Sequelize.CHAR(32).BINARY,
  meta: Sequelize.TEXT,
  
  total_tx: Sequelize.INTEGER
})


// stores all payment channels, offdelta and last signatures
// TODO: seamlessly cloud backup it. If signatures are lost, money is lost

// we name our things "value", and counterparty's "they_value" 
Delta = privSequelize.define('delta', {
  // between who and who
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.CHAR(32).BINARY,

  // higher nonce is valid
  nonce: Sequelize.INTEGER,
  status: Sequelize.TEXT,

  instant_until: Sequelize.INTEGER,

  // TODO: clone from Insurance table to Delta to avoid double querying both dbs
  insurance: Sequelize.INTEGER,
  ondelta: Sequelize.INTEGER,


  offdelta: Sequelize.INTEGER,

  soft_limit: Sequelize.INTEGER,
  hard_limit: Sequelize.INTEGER, // we trust up to

  they_soft_limit: Sequelize.INTEGER,
  they_hard_limit: Sequelize.INTEGER, // they trust us


  last_online: Sequelize.DATE,
  withdrawal_requested_at: Sequelize.DATE,

  they_input_amount: Sequelize.INTEGER,

  input_amount: Sequelize.INTEGER,
  input_sig: Sequelize.TEXT, // we store a withdrawal sig to use in next rebalance

  hashlocks: Sequelize.TEXT,

  sig: Sequelize.TEXT,
  signed_state: Sequelize.TEXT,

  // testnet: cheaty transaction
  most_profitable: Sequelize.TEXT

})

Transition = privSequelize.define('transition', {

  // await, sent, ready
  status: Sequelize.TEXT,

  // who is recipient
  mediate_to: Sequelize.TEXT,

  // string needed to decrypt
  unlocker: Sequelize.TEXT,

  // a change in offdelta 
  offdelta: Sequelize.INTEGER,
  hash: Sequelize.TEXT,
  // best by block
  exp: Sequelize.INTEGER
})

Delta.hasMany(Transition)
Transition.belongsTo(Delta)





Delta.prototype.getState = async function () {
  var compared = Buffer.compare(this.myId, this.partnerId)

  var state = [
    methodMap('dispute'),
    compared==-1?this.myId:this.partnerId,
    compared==-1?this.partnerId:this.myId,
    this.nonce,
    this.offdelta,
    (await this.getTransitions({where: {status: 'hashlock'}})).map(
      t=>[t.offdelta, t.hash, t.exp]
    )
  ]

  return state
}






Delta.prototype.getDispute = async function() {
  // post last sig if any
  var partner = await User.idOrKey(this.partnerId)
  return this.sig ? [partner.id, this.sig, this.nonce, this.offdelta, []] : [partner.id]
}

Delta.prototype.startDispute = async function(profitable) {
  if (profitable) {
    if (this.most_profitable) {          
      var profitable = r(this.most_profitable)
      this.offdelta = readInt(profitable[0])
      this.nonce = readInt(profitable[1])
      this.sig = profitable[2]
    } else {
      this.sig = null
    }
  }

  if (me.is_hub) {
    this.status = 'cheat_dispute'
    // we don't broadcast dispute right away and wait until periodic rebalance
  } else {
    this.status = 'disputed'
    await me.broadcast('rebalance', r([ [(await this.getDispute())], [],[] ]))    
  }

  await this.save()

}

History = privSequelize.define('history', {
  leftId: Sequelize.CHAR(32).BINARY,
  rightId: Sequelize.CHAR(32).BINARY,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT

})

Purchase = privSequelize.define('purchase', {
  myId: Sequelize.CHAR(32).BINARY,
  partnerId: Sequelize.INTEGER,

  delta: Sequelize.INTEGER,

  amount: Sequelize.INTEGER,
  balance: Sequelize.INTEGER,
  desc: Sequelize.TEXT,

  date: { type: Sequelize.DATE, defaultValue: Sequelize.NOW }

})

Event = privSequelize.define('event', {
  data: Sequelize.CHAR.BINARY,
  kindof: Sequelize.STRING,
  p1: Sequelize.STRING
})

sync = () => {
  if (K.prev_hash) {

    me.send(Members[Math.floor(Math.random()*Members.length)], 'sync', Buffer.from(K.prev_hash, 'hex'))
  }
}



city = async () => {
  for (var i = 0; i < 50; i++) {
    await me.payChannel({
      partner: crypto.randomBytes(32),
      amount: Math.round(Math.random()*120000)
    })
  }

  l('Ready')
}



var argv = require('minimist')(process.argv.slice(2), {
  string: ['username', 'pw']
})

base_port = argv.p ? parseInt(argv.p) : 8000;

(async () => {
  if (argv.console) {

  } else if (process.argv[2] == 'city') {
    city()
  } else if (argv.genesis) {
    require('./src/genesis')(argv.genesis)
  } else {
    if (fs.existsSync('data/k.json')) {
      l('Loading K data')
      var json = fs.readFileSync('data/k.json')
      K = JSON.parse(json)

      Members = JSON.parse(json).members // another object ref
      for (m of Members) {
        m.pubkey = Buffer.from(m.pubkey, 'hex')
        m.block_pubkey = Buffer.from(m.block_pubkey, 'hex')
      }

    } else {
      throw "No K.json"
    }

    await privSequelize.sync({force: false})

    /*
    TODO: fault tolerant reloader 


    var cluster = require('cluster')
    if (cluster.isMaster) {
      cluster.fork();

      cluster.on('exit', function(worker, code, signal) {
        console.log('exit')
        //cluster.fork();
      });
    }

    if (cluster.isWorker) { */
    initDashboard()
    // }
  }
})()

process.on('unhandledRejection', r => console.log(r))



repl = require('repl').start('> ')
_eval = repl.eval

// top level await in repl
repl.eval = (cmd, context, filename, callback) => {
  if (cmd.indexOf('await') != -1) cmd = `(function(){ async function _wrap() { console.log(${cmd}) } return _wrap() })()`
  _eval(cmd, context, filename, callback)
}
