var pull = require('pull-stream')
var Reduce = require('flumeview-reduce')
var I = require('./valid')

function code(err, c) {
  err.code = 'user-invites:'+c
  return err
}

function all (stream, cb) {
  return pull(stream, pull.collect(cb))
}

function isFunction (f) {
  return typeof f === 'function'
}

exports.name = 'user-invites'

exports.version = '1.0.0'
exports.manifest = {
  getInvite: 'async',
  confirm: 'async',
  create: 'async'
}

exports.permissions = {
//  master: {allow: ['create']}
}

// KNOWN BUG: it's possible to accept an invite more than once,
// but peers will ignore subsequent acceptances. it's possible
// that this could create confusion in certain situations.
// (but you'd get a feed that some peers thought was invited by Alice
// other peers would think a different feed accepted that invite)
// I guess the answer is to let alice reject the second invite?)
// that would be easier to do if this was a levelreduce? (keys: reduce, instead of a single reduce?)

exports.init = function (sbot, config) {
  var init = false
  var layer = sbot.friends.createLayer('user-invites')

  var invites = sbot._flumeUse('user-invites', Reduce(2, function (acc, data, _seq) {
    if(!acc) acc = {invited: {}, invites:{}, accepts: {}, hosts: {}}
    var msg = data.value
    var invite, accept
    if(msg.content.type === 'user-invite') {
      //TODO: validate that this is a msg we understand!
      invite = msg
      accept = acc.accepts[data.key]
    }
    else if(msg.content.type === 'user-invite/accept') {
      accept = msg
      invite = acc.invites[accept.content.receipt]
    }
    else if(msg.content.type === 'user-invite/confirm') {
      //TODO: just for when we are the guest, but we need to make sure at least one confirm exists.
      accept = msg.content.embed
      invite = acc.invites[accept.content.receipt]
    }

    if(invite && accept) {
      if(invite === true)
        return acc
      var invite_id = accept.content.receipt
      try { I.verifyAccept(accept, invite) }
      catch (err) { return acc }
      //fall through from not throwing

      //delete matched invites, but _only_ if they are VALID. (returned in the catch if invalid)
      delete acc.accepts[invite_id]
      //but remember that this invite has been processed.
      acc.invites[invite_id] = true
      acc.hosts[invite.author] = acc.hosts[invite.author] || {}
      acc.hosts[invite.author][accept.author] = 1
      if(init) {
        //interpret accepting an invite as a mutual follow.
        layer(invite.author, accept.author, 1)
        layer(accept.author, invite.author, 1)
      }
    }
    else if(invite)
      acc.invites[data.key] = invite
    else if(accept)
      acc.accepts[accept.receipt] = accept

    return acc
  }))

  invites.get(function (_, invites) {
    var g = {}
    if(!invites) layer({})
    else {
      //interpret accepted invites as two-way, but only store a minimal host->guest data structure
      for(var j in invites.hosts)
        for(var k in invites.hosts[j])
          g[j][k] = g[k][j] = 1
      init = true
      layer(g)
    }
  })

  sbot.auth.hook(function (fn, args) {
    var id = args[0], cb = args[1]
    invites.get(function (err, v) {
      if(err) return cb(err)
      for(var k in v.invites) {
        if(v.invites[k].content.invite === id) {
          return cb(null, {
            allow: ['userInvites.getInvite', 'userInvites.confirm'],
            deny: null
          })
        }
      }
      fn.apply(null, args)
    })
  })

  //retrive full invitation.
  invites.getInvite = function (invite_id, cb) {
    var self = this
    invites.get(function (err, v) {
      var invite = v.invites[invite_id]
      if(err) return cb(err)
      if(!invite)
        cb(code(
          new Error('unknown invite:'+invite_id),
          'unknown-invite'
        ))
      else if(invite === true)
        //TODO just retrive all confirmations we know about
        //via links.
        sbot.get(invite_id, cb)
      //only allow the guest to request their own invite.
      else if(self.id !== invite.content.invite)
        cb(code(
          new Error('invite did not match client id'),
          'invite-mismatch'
        ))
      else
        cb(null, v.invites[invite_id])
    })
  }

  function getResponse (invite_id, test, cb) {
    return all(
      sbot.links({dest: invite_id, values: true, keys: false, meta: false}),
      function (err, confirms) {
        if(err) cb(err)
        else cb(null,
          confirms.filter(function (e) {
            try {
              return test(e)
            } catch (err) {
              return false
            }
          })[0]
        )
      }
    )
  }

  var accepted = {}

  function getConfirm (invite_id, cb) {

    getResponse(invite_id, function (msg) {
      return (
        msg.content.type === 'user-invite/confirm' &&
        msg.content.embed.content.receipt === invite_id
      )
    }, cb)
  }


  function getAccept (invite_id, cb) {
    getResponse(invite_id, function (msg) {
      return (
        msg.content.type === 'user-invite/accept' &&
        msg.content.receipt === invite_id
      )
    }, cb)
  }


  //used to request that a server confirms your acceptance.
  invites.confirm = function (accept, cb) {
    var invite_id = accept.content.receipt
    //check if the invite in question hasn't already been accepted.
    getConfirm(invite_id, function (err, confirm) {
      if(err) return cb(err)
      if(confirm) return cb(null, confirm)

      sbot.get(invite_id, function (err, invite) {
        try {
          I.verifyAccept(accept, invite)
        } catch (err) {
          return cb(err)
        }
        //there is a little race condition here, if accept is called again
        //before this write completes, it will write twice, so just return an error.
        if(accepted[invite_id]) return cb(new Error('race condition: try again soon'))

        accepted[invite_id] = true
        sbot.publish({
          type: 'user-invite/confirm',
          embed: accept,
          //second pointer back to receipt, so that links can find it
          //(since it unfortunately does not handle links nested deeper
          //inside objects. when we look up the message,
          //confirm that content.embed.content.receipt is the same)
          receipt: accept.content.receipt
        }, function (err, data) {
          delete accepted[invite_id]
          cb(err, data.value)
        })
      })
    })
  }

  //retrive pubs who might be willing to confirm your invite. (used when creating an invte)
  function getNearbyPubs (opts, cb) {
    var maxHops = opts.hops || 2
    sbot.deviceAddress.getState(function (err, state) {
      if(err) return cb(explain(err, 'could not retrive any device addresses'))
      sbot.friends.hops({hops: opts.hops, reverse: true}, function (err, hops) {
        if(err) return cb(explain(err, 'could not retrive nearby friends'))
        var near = []
        for(var k in state) {
          var da = state[k]
          if(hops[k] <= maxHops) {
            near.push({
              id: k,
              address: da.address,
              hops: hops[k],
              availability: da.availability
            })
          }
        }
        //sort by reverse hops, then by decending availability.
        //default availibility
        near.sort(function (a, b) {
          return (
            a.hops - b.hops ||
            b.availability - a.availability
          )
        })
        cb(null, near)
      })
    })
  }

  invites.create = function (opts, cb) {
    if(isFunction(opts))
      return opts(new Error ('user-invites: expected: options *must* be provided.'))

    getNearbyPubs(opts, function (err, near) {
      var seed = crypto.randomBytes(32)
      sbot.identities.publishAs({
        id: opts.id || sbot.id,
        content: valid.createInvite(seed, opts.id || sbot.id, opts.reveal, opts.private)
      }, function (err, data) {
        cb(null, {
          seed: seed,
          invite: data.key,
          pubs: near,
        })
      })
    })
  }

  //try each of an array of addresses, and cb the first one that works.
  function connectFirst (keys, pubs, cb) {
    var n = 0, err
    pubs.forEach(function (addr) {
      n++
      ssbClient(keys, {
        remote: addr,
        caps: require('ssb-config').caps,
        manifest: {
          userInvites: {
            getInvite: 'async',
            confirm: 'async'
          }
        }
      }, function (_err, rpc) {
        if(n > 0 && rpc) {
          n = -1
          cb(null, rpc)
        } else {
          err = err || _err
        }
        if(--n == 0) cb(err)
      })
    })
  }

  //TODO: check if invite is already held locally
  //      if so, just get it. when got, update local db.
  invites.openInvite = function (invite, cb) {
    invites.getInvite(invite.invite, function (err, msg) {
      if(msg)
        next(msg)
      else {
        var pubs = invite.pubs
        var keys = ssbKeys.generate(null, invite.seed)
        connectFirst(keys, pubs, function (err, rpc) {
          if(err) return cb(err)
          rpc.userInvites.getInvite(invite.invite, function (err, msg) {
            if(err) return cb(err)
            next(msg)
          })
        })
      }

      function next (msg) {
        var inviteId = '%'+ssbKeys.hash(JSON.stringify(msg, null, 2))
        if(invite.invite !== inviteId)
          return cb(new Error(
            'incorrect invite was returned! expected:'+invite.invite+', but got:'+inviteId
          ))
        var opened
        try { opened = valid.verifyInvitePrivate(msg, invite.seed) }
        catch (err) { return cb(err) }
        //TODO: add msg to reduce state.
        cb(null, opened)
      }
    })
  }

  function getAccept (invite_id, cb) {
    invites.get(function (err, state) {
      var accept = state.accepts[invite_id]
      if(accept) next(accept) //check confirm
      else
        all(sbot.links({dest: invite_id, values: true}), function (err, all) {
          if(err) return cb(err)
          cb(null, all.filter(function (msg) {
            
          }))
        })
    })
  }

  invites.acceptInvite = function (opts, cb) {
    var invite = opts.invite || opts
    var id = opts.id || sbot.id
    var pubs = invite.pubs
    var keys = ssbKeys.generate(null, invite.seed)

    //check wether this invite is already accepted.
    //or if the acceptance has been publish, but not yet confirmed.
  }
  return invites
}

