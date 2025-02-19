import { PeerScoreParams, validatePeerScoreParams } from './peer-score-params'
import { PeerStats, createPeerStats, ensureTopicStats } from './peer-stats'
import { computeScore } from './compute-score'
import { MessageDeliveries, DeliveryRecordStatus } from './message-deliveries'
import { MessageIdFunction } from '../interfaces'
import { ERR_TOPIC_VALIDATOR_IGNORE } from '../constants'
import PeerId from 'peer-id'
import ConnectionManager from 'libp2p/src/connection-manager'
import { InMessage } from 'libp2p-interfaces/src/pubsub'
import debug = require('debug')
import pubsubErrors = require('libp2p-interfaces/src/pubsub/errors')

const {
  ERR_INVALID_SIGNATURE,
  ERR_MISSING_SIGNATURE
} = pubsubErrors.codes

const log = debug('libp2p:gossipsub:score')

export class PeerScore {
  /**
   * The score parameters
   */
  params: PeerScoreParams
  /**
   * Per-peer stats for score calculation
   */
  peerStats: Map<string, PeerStats>
  /**
   * IP colocation tracking; maps IP => set of peers.
   */
  peerIPs: Map<string, Set<string>>
  /**
   * Recent message delivery timing/participants
   */
  deliveryRecords: MessageDeliveries
  /**
   * Message ID function
   */
  msgId: MessageIdFunction
  _connectionManager: ConnectionManager
  _backgroundInterval?: NodeJS.Timeout

  constructor (params: PeerScoreParams, connectionManager: ConnectionManager, msgId: MessageIdFunction) {
    validatePeerScoreParams(params)
    this.params = params
    this._connectionManager = connectionManager
    this.peerStats = new Map()
    this.peerIPs = new Map()
    this.deliveryRecords = new MessageDeliveries()
    this.msgId = msgId
  }

  /**
   * Start PeerScore instance
   * @returns {void}
   */
  start (): void {
    if (this._backgroundInterval) {
      log('Peer score already running')
      return
    }
    this._backgroundInterval = setInterval(() => this.background(), this.params.decayInterval)
    log('started')
  }

  /**
   * Stop PeerScore instance
   * @returns {void}
   */
  stop (): void {
    if (!this._backgroundInterval) {
      log('Peer score already stopped')
      return
    }
    clearInterval(this._backgroundInterval)
    delete this._backgroundInterval
    this.peerIPs.clear()
    this.peerStats.clear()
    this.deliveryRecords.clear()
    log('stopped')
  }

  /**
   * Periodic maintenance
   * @returns {void}
   */
  background (): void {
    this._refreshScores()
    this._updateIPs()
    this.deliveryRecords.gc()
  }

  /**
   * Decays scores, and purges score records for disconnected peers once their expiry has elapsed.
   * @returns {void}
   */
  _refreshScores (): void {
    const now = Date.now()
    const decayToZero = this.params.decayToZero

    this.peerStats.forEach((pstats, id) => {
      if (!pstats.connected) {
        // has the retention perious expired?
        if (now > pstats.expire) {
          // yes, throw it away (but clean up the IP tracking first)
          this._removeIPs(id, pstats.ips)
          this.peerStats.delete(id)
        }

        // we don't decay retained scores, as the peer is not active.
        // this way the peer cannot reset a negative score by simply disconnecting and reconnecting,
        // unless the retention period has ellapsed.
        // similarly, a well behaved peer does not lose its score by getting disconnected.
        return
      }

      Object.entries(pstats.topics).forEach(([topic, tstats]) => {
        const tparams = this.params.topics[topic]
        if (!tparams) {
          // we are not scoring this topic
          // should be unreachable, we only add scored topics to pstats
          return
        }

        // decay counters
        tstats.firstMessageDeliveries *= tparams.firstMessageDeliveriesDecay
        if (tstats.firstMessageDeliveries < decayToZero) {
          tstats.firstMessageDeliveries = 0
        }
        tstats.meshMessageDeliveries *= tparams.meshMessageDeliveriesDecay
        if (tstats.meshMessageDeliveries < decayToZero) {
          tstats.meshMessageDeliveries = 0
        }
        tstats.meshFailurePenalty *= tparams.meshFailurePenaltyDecay
        if (tstats.meshFailurePenalty < decayToZero) {
          tstats.meshFailurePenalty = 0
        }
        tstats.invalidMessageDeliveries *= tparams.invalidMessageDeliveriesDecay
        if (tstats.invalidMessageDeliveries < decayToZero) {
          tstats.invalidMessageDeliveries = 0
        }
        // update mesh time and activate mesh message delivery parameter if need be
        if (tstats.inMesh) {
          tstats.meshTime = now - tstats.graftTime
          if (tstats.meshTime > tparams.meshMessageDeliveriesActivation) {
            tstats.meshMessageDeliveriesActive = true
          }
        }
      })
      // decay P7 counter
      pstats.behaviourPenalty *= this.params.behaviourPenaltyDecay
      if (pstats.behaviourPenalty < decayToZero) {
        pstats.behaviourPenalty = 0
      }
    })
  }

  /**
   * Return the score for a peer
   * @param {string} id
   * @returns {Number}
   */
  score (id: string): number {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return 0
    }
    return computeScore(id, pstats, this.params, this.peerIPs)
  }

  /**
   * Apply a behavioural penalty to a peer
   * @param {string} id
   * @param {Number} penalty
   * @returns {void}
   */
  addPenalty (id: string, penalty: number): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }
    pstats.behaviourPenalty += penalty
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  addPeer (id: string): void {
    // create peer stats (not including topic stats for each topic to be scored)
    // topic stats will be added as needed
    const pstats = createPeerStats({
      connected: true
    })
    this.peerStats.set(id, pstats)

    // get + update peer IPs
    const ips = this._getIPs(id)
    this._setIPs(id, ips, pstats.ips)
    pstats.ips = ips
  }

  /**
   * @param {string} id
   * @returns {void}
   */
  removePeer (id: string): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    // decide whether to retain the score; this currently only retains non-positive scores
    // to dissuade attacks on the score function.
    if (this.score(id) > 0) {
      this._removeIPs(id, pstats.ips)
      this.peerStats.delete(id)
      return
    }

    // furthermore, when we decide to retain the score, the firstMessageDelivery counters are
    // reset to 0 and mesh delivery penalties applied.
    Object.entries(pstats.topics).forEach(([topic, tstats]) => {
      tstats.firstMessageDeliveries = 0

      const threshold = this.params.topics[topic].meshMessageDeliveriesThreshold
      if (tstats.inMesh && tstats.meshMessageDeliveriesActive && tstats.meshMessageDeliveries < threshold) {
        const deficit = threshold - tstats.meshMessageDeliveries
        tstats.meshFailurePenalty += deficit * deficit
      }

      tstats.inMesh = false
    })

    pstats.connected = false
    pstats.expire = Date.now() + this.params.retainScore
  }

  /**
   * @param {string} id
   * @param {String} topic
   * @returns {void}
   */
  graft (id: string, topic: string): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    const tstats = ensureTopicStats(topic, pstats, this.params)
    if (!tstats) {
      return
    }

    tstats.inMesh = true
    tstats.graftTime = Date.now()
    tstats.meshTime = 0
    tstats.meshMessageDeliveriesActive = false
  }

  /**
   * @param {string} id
   * @param {string} topic
   * @returns {void}
   */
  prune (id: string, topic: string): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    const tstats = ensureTopicStats(topic, pstats, this.params)
    if (!tstats) {
      return
    }

    // sticky mesh delivery rate failure penalty
    const threshold = this.params.topics[topic].meshMessageDeliveriesThreshold
    if (tstats.meshMessageDeliveriesActive && tstats.meshMessageDeliveries < threshold) {
      const deficit = threshold - tstats.meshMessageDeliveries
      tstats.meshFailurePenalty += deficit * deficit
    }
    tstats.inMesh = false
  }

  /**
   * @param {InMessage} message
   * @returns {Promise<void>}
   */
  async validateMessage (message: InMessage): Promise<void> {
    this.deliveryRecords.ensureRecord(await this.msgId(message))
  }

  /**
   * @param {InMessage} message
   * @returns {Promise<void>}
   */
  async deliverMessage (message: InMessage): Promise<void> {
    const id = message.receivedFrom
    this._markFirstMessageDelivery(id, message)

    const drec = this.deliveryRecords.ensureRecord(await this.msgId(message))
    const now = Date.now()

    // defensive check that this is the first delivery trace -- delivery status should be unknown
    if (drec.status !== DeliveryRecordStatus.unknown) {
      log(
        'unexpected delivery: message from %s was first seen %s ago and has delivery status %d',
        id, now - drec.firstSeen, DeliveryRecordStatus[drec.status]
      )
      return
    }

    // mark the message as valid and reward mesh peers that have already forwarded it to us
    drec.status = DeliveryRecordStatus.valid
    drec.validated = now
    drec.peers.forEach(p => {
      // this check is to make sure a peer can't send us a message twice and get a double count
      // if it is a first delivery.
      if (p !== id) {
        this._markDuplicateMessageDelivery(p, message)
      }
    })
  }

  /**
   * @param {InMessage} message
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async rejectMessage (message: InMessage, reason: string): Promise<void> {
    const id = message.receivedFrom
    switch (reason) {
      case ERR_MISSING_SIGNATURE:
      case ERR_INVALID_SIGNATURE:
        this._markInvalidMessageDelivery(id, message)
        return
    }

    const drec = this.deliveryRecords.ensureRecord(await this.msgId(message))

    // defensive check that this is the first rejection -- delivery status should be unknown
    if (drec.status !== DeliveryRecordStatus.unknown) {
      log(
        'unexpected rejection: message from %s was first seen %s ago and has delivery status %d',
        id, Date.now() - drec.firstSeen, DeliveryRecordStatus[drec.status]
      )
      return
    }

    switch (reason) {
      case ERR_TOPIC_VALIDATOR_IGNORE:
        // we were explicitly instructed by the validator to ignore the message but not penalize the peer
        drec.status = DeliveryRecordStatus.ignored
        return
    }

    // mark the message as invalid and penalize peers that have already forwarded it.
    drec.status = DeliveryRecordStatus.invalid

    this._markInvalidMessageDelivery(id, message)
    drec.peers.forEach(p => {
      this._markInvalidMessageDelivery(p, message)
    })
  }

  /**
   * @param {InMessage} message
   * @returns {Promise<void>}
   */
  async duplicateMessage (message: InMessage): Promise<void> {
    const id = message.receivedFrom
    const drec = this.deliveryRecords.ensureRecord(await this.msgId(message))

    if (drec.peers.has(id)) {
      // we have already seen this duplicate
      return
    }

    switch (drec.status) {
      case DeliveryRecordStatus.unknown:
        // the message is being validated; track the peer delivery and wait for
        // the Deliver/Reject/Ignore notification.
        drec.peers.add(id)
        break
      case DeliveryRecordStatus.valid:
        // mark the peer delivery time to only count a duplicate delivery once.
        drec.peers.add(id)
        this._markDuplicateMessageDelivery(id, message, drec.validated)
        break
      case DeliveryRecordStatus.invalid:
        // we no longer track delivery time
        this._markInvalidMessageDelivery(id, message)
        break
    }
  }

  /**
   * Increments the "invalid message deliveries" counter for all scored topics the message is published in.
   * @param {string} id
   * @param {InMessage} message
   * @returns {void}
   */
  _markInvalidMessageDelivery (id: string, message: InMessage): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    message.topicIDs.forEach(topic => {
      const tstats = ensureTopicStats(topic, pstats, this.params)
      if (!tstats) {
        return
      }

      tstats.invalidMessageDeliveries += 1
    })
  }

  /**
   * Increments the "first message deliveries" counter for all scored topics the message is published in,
   * as well as the "mesh message deliveries" counter, if the peer is in the mesh for the topic.
   * @param {string} id
   * @param {InMessage} message
   * @returns {void}
   */
  _markFirstMessageDelivery (id: string, message: InMessage): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    message.topicIDs.forEach(topic => {
      const tstats = ensureTopicStats(topic, pstats, this.params)
      if (!tstats) {
        return
      }

      let cap = this.params.topics[topic].firstMessageDeliveriesCap
      tstats.firstMessageDeliveries += 1
      if (tstats.firstMessageDeliveries > cap) {
        tstats.firstMessageDeliveries = cap
      }

      if (!tstats.inMesh) {
        return
      }

      cap = this.params.topics[topic].meshMessageDeliveriesCap
      tstats.meshMessageDeliveries += 1
      if (tstats.meshMessageDeliveries > cap) {
        tstats.meshMessageDeliveries = cap
      }
    })
  }

  /**
   * Increments the "mesh message deliveries" counter for messages we've seen before,
   * as long the message was received within the P3 window.
   * @param {string} id
   * @param {InMessage} message
   * @param {number} validatedTime
   * @returns {void}
   */
  _markDuplicateMessageDelivery (id: string, message: InMessage, validatedTime = 0): void {
    const pstats = this.peerStats.get(id)
    if (!pstats) {
      return
    }

    const now = validatedTime ? Date.now() : 0

    message.topicIDs.forEach(topic => {
      const tstats = ensureTopicStats(topic, pstats, this.params)
      if (!tstats) {
        return
      }

      if (!tstats.inMesh) {
        return
      }

      const tparams = this.params.topics[topic]

      // check against the mesh delivery window -- if the validated time is passed as 0, then
      // the message was received before we finished validation and thus falls within the mesh
      // delivery window.
      if (validatedTime && now > validatedTime + tparams.meshMessageDeliveriesWindow) {
        return
      }

      const cap = tparams.meshMessageDeliveriesCap
      tstats.meshMessageDeliveries += 1
      if (tstats.meshMessageDeliveries > cap) {
        tstats.meshMessageDeliveries = cap
      }
    })
  }

  /**
   * Gets the current IPs for a peer.
   * @param {string} id
   * @returns {Array<string>}
   */
  _getIPs (id: string): string[] {
    return this._connectionManager.getAll(PeerId.createFromB58String(id))
      .map(c => c.remoteAddr.toOptions().host)
  }

  /**
   * Adds tracking for the new IPs in the list, and removes tracking from the obsolete IPs.
   * @param {string} id
   * @param {Array<string>} newIPs
   * @param {Array<string>} oldIPs
   * @returns {void}
   */
  _setIPs (id: string, newIPs: string[], oldIPs: string[]): void {
    // add the new IPs to the tracking
    // eslint-disable-next-line no-labels
    addNewIPs:
    for (const ip of newIPs) {
      // check if it is in the old ips list
      for (const xip of oldIPs) {
        if (ip === xip) {
          // eslint-disable-next-line no-labels
          continue addNewIPs
        }
      }
      // no, it's a new one -- add it to the tracker
      let peers = this.peerIPs.get(ip)
      if (!peers) {
        peers = new Set()
        this.peerIPs.set(ip, peers)
      }
      peers.add(id)
    }
    // remove the obsolete old IPs from the tracking
    // eslint-disable-next-line no-labels
    removeOldIPs:
    for (const ip of oldIPs) {
      // check if it is in the new ips list
      for (const xip of newIPs) {
        if (ip === xip) {
          // eslint-disable-next-line no-labels
          continue removeOldIPs
        }
      }
      // no, its obselete -- remove it from the tracker
      const peers = this.peerIPs.get(ip)
      if (!peers) {
        continue
      }
      peers.delete(id)
      if (!peers.size) {
        this.peerIPs.delete(ip)
      }
    }
  }

  /**
   * Removes an IP list from the tracking list for a peer.
   * @param {string} id
   * @param {Array<string>} ips
   * @returns {void}
   */
  _removeIPs (id: string, ips: string[]): void {
    ips.forEach(ip => {
      const peers = this.peerIPs.get(ip)
      if (!peers) {
        return
      }

      peers.delete(id)
      if (!peers.size) {
        this.peerIPs.delete(ip)
      }
    })
  }

  /**
   * Update all peer IPs to currently open connections
   * @returns {void}
   */
  _updateIPs (): void {
    this.peerStats.forEach((pstats, id) => {
      const newIPs = this._getIPs(id)
      this._setIPs(id, newIPs, pstats.ips)
      pstats.ips = newIPs
    })
  }
}
