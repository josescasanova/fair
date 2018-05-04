// This method gets Insurance from onchain db, Delta from offchain db
// then derives a ton of info about current channel - who owns what, what's promised, what's insiured etc

// TODO: periodically clone Insurance to Delta db to only deal with one db having all data
module.exports = async (partner = Members[0].pubkey, asset = 0) => {
  // accepts pubkey only
  var compared = Buffer.compare(me.pubkey, partner)
  if (compared == 0) return false

  var ch = {
    // default insurance
    insurance: 0,
    ondelta: 0,
    nonce: 0,
    left: compared == -1,

    online:
      me.users[partner] &&
      (me.users[partner].readyState == 1 ||
        (me.users[partner].instance &&
          me.users[partner].instance.readyState == 1))
  }

  me.record = await me.byKey()

  var my_hub = (p) => K.hubs.find((m) => m.pubkey == toHex(p))
  ch.hub = my_hub(partner) || {handle: toHex(partner).substr(0, 10)}

  // ch stands for Channel, d for Delta record, yes
  var created = await Delta.findOrCreate({
    where: {
      myId: me.pubkey,
      partnerId: partner,
      asset: asset
    },
    defaults: {
      nonce: 0,
      status: 'master',
      offdelta: 0,
      asset: asset,

      input_amount: 0,
      they_input_amount: 0,

      soft_limit: my_hub(partner) ? K.risk : 0,
      hard_limit: my_hub(partner) ? K.hard_limit : 0,

      they_soft_limit: my_hub(me.pubkey) ? K.risk : 0,
      they_hard_limit: my_hub(me.pubkey) ? K.hard_limit : 0
    }
  })
  if (created[1]) loff(`Creating channel ${trim(partner)}`)
  ch.d = created[0]

  //await ch.d.save()

  var user = await me.byKey(partner)
  if (user) {
    ch.partner = user.id
    if (me.record) {
      ch.ins = await Insurance.find({
        where: {
          leftId: ch.left ? me.record.id : user.id,
          rightId: ch.left ? user.id : me.record.id
        }
      })
    }
  }

  if (ch.ins) {
    ch.insurance = ch.ins.insurance
    ch.ondelta = ch.ins.ondelta
    ch.nonce = ch.ins.nonce
  }

  // ch.d.state = JSON.parse(ch.d.state)

  ch.delta = ch.ondelta + ch.d.offdelta

  Object.assign(ch, resolveChannel(ch.insurance, ch.delta, ch.left))

  // We reduce payable by total amount of unresolved hashlocks in either direction
  var state = await ch.d.getState()
  var left_inwards = 0
  state[2].map((a) => (left_inwards += a[0]))
  var right_inwards = 0
  state[3].map((a) => (right_inwards += a[0]))

  ch.payable =
    ch.insured -
    ch.d.input_amount +
    ch.they_promised +
    (ch.d.they_hard_limit - ch.promised) -
    (ch.left ? right_inwards : left_inwards)

  ch.they_payable =
    ch.they_insured -
    ch.d.they_input_amount +
    ch.promised +
    (ch.d.hard_limit - ch.they_promised) -
    (ch.left ? left_inwards : right_inwards)

  // inputs are like bearer cheques and can be used any minute, so we deduct them

  // All stuff we show in the progress bar in the wallet
  ch.bar = ch.promised + ch.insured + ch.they_insured + ch.they_promised

  return ch
}
