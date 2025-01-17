/*!
 * axfr.js - AXFR plugin for hsd
 * Copyright (c) 2021 Buffrr (MIT License).
 *
 * parts of this software are based on:
 * https://github.com/handshake-org/hsd
 * https://github.com/chjj/bns
 */

'use strict';

const plugin = exports;

// this is probably a very hacky way
// to get those dependencies from hsd
const NameState = require('../../lib/covenants/namestate');
const {Resource} = require('../../lib/dns/resource');
const IP = require('binet');
const base32 = require('bcrypto/lib/encoding/base32');
const ext_util = require('util');

const {
  AXFRClient,
  AXFRValidator,
  MessageWriter
} = require('../lib/client');

const {
  wire,
  util
} = require('bns');

const {
  Message,
  types,
  algs,
  algsByVal,
  codes
} = wire;

const keepTypesCname = { [types.CNAME]: true };
const keepTypesNs = { [types.NS]:true, [types.DS]:true, [types.A]:true, [types.AAAA]:true };

/**
 * Plugin
 */

class Plugin {
  /**
   * Create a plugin.
   * @constructor
   * @param {Node} node the node
   */
  constructor(node) {
    this.ns = node.ns;
    this.logger = node.logger.context('axfr');
    this.chain = node.chain;
    this.ipList = node.config.str('axfr-allow-ips', '127.0.0.1').split(/[ ]+/);
    this.preferICANN = node.config.bool('axfr-prefer-icann', false);
    this.disableMerge = node.config.bool('axfr-no-icann', false);

    const defaultServers = 'b.root-servers.net ' +
      'c.root-servers.net ' +
      'f.root-servers.net';
    this.icannServers = node.config.str('axfr-icann-servers', defaultServers);

    // root server and full node are required
    if (!this.ns || this.chain.options.spv)
      return;

    const clientOptions = {
      logger: this.logger,
      servers: this.icannServers.split(/[ ]+/)
    };

    this.axfrClient = new AXFRClient(clientOptions);
    this.ns.middle = async (tld, req, rinfo) => {
      const [qs] = req.question;
      const {name, type} = qs;
      if (name === '.' && type === types.AXFR)
        return await this.sendAXFR(req, rinfo);

      return null;
    };
  }

  async write(msg, port, host) {
    const key = IP.toHost(host, port);
    const socket = this.ns.server.sockets.get(key);

    if (!socket)
      return false;

    socket.write(msg);
    return true;
  }

  pickRRs(name, hnsZone, mergeDB) {
    const collision = mergeDB.nsecChain.has(name);
    if (!collision) {
      return hnsZone;
    }

    this.logger.warning('name collision for ' + name +
      ' (prefer icann: ' + this.preferICANN + ')');

    if (!this.preferICANN) {
      mergeDB.nsecChain.delete(name);
      return hnsZone;
    }

    return [];
  }

  generateSynth(name) {
    const labels = util.split(name);
    const hash = util.label(name, labels, -2);

    const synth = new wire.Record();
    synth.name = name;
    synth.ttl = 21600;

    const ip = IP.map(base32.decodeHex(hash.substring(1)));

    if (IP.isIPv4(ip)) {
      synth.type = types.A;
      synth.data = new wire.ARecord();
    } else {
      synth.type = types.AAAA;
      synth.data = new wire.AAAARecord();
    }

    synth.data.address = IP.toString(ip);
    return synth;
  }

  allowableRrTypes(zone) {
  	let haveTypes = {};
  	for (const rr of zone) haveTypes[rr.type] = true;

  	if (haveTypes[types.CNAME]) return keepTypesCname;
  	if (haveTypes[types.NS]) return keepTypesNs;
  	return null;
  	}

  async sendAXFR(req, rinfo) {
    const {port, address, tcp} = rinfo;
    if (!tcp) {
      this.logger.debug('No zone transfer requests over udp.');

      return this.refuse();
    }

    if (!this.ipList.includes(address)) {
      this.logger.debug('Address %s cannot send zone transfer request ' +
        'check allowed ip addresses.', address);

      return this.refuse();
    }

    // load & verify ICANN root zone
    const mergeDB = await this.loadMergeZone();
    if (!mergeDB)
      throw new Error('unable to load icann root zone');

    mergeDB.nsecChain.delete('.');

    const prefix = '[' + address + ':' + port + '] ';
    this.logger.info(prefix + ' Starting zone transfer');

    const self = this;
    const transfer = new MessageWriter(req, async function (data) {
      const ok = await self.write(data, port, address);
      self.logger.info(prefix + 'Records sent ' + this.written);

      if (!ok)
        self.logger.error(prefix + 'Transfer cancelled');
      return ok;
    });

    // first message has SOA
    const soa = this.ns.toSOA();

    // root NS/A/AAAA records
    const ns = this.ns.toNS();
    let rootIP;
    if (IP.family(this.ns.publicHost) === 4) {
      rootIP = this.ns.toA();
    } else {
      rootIP = this.ns.toAAAA();
    }

    await transfer.writeAll([soa, ns, rootIP]);

    const tree = this.chain.db.tree;
    const iter = tree.iterator(true);

    // this is based on the dumpzone rpc call
    // in hsd (not yet merged)

    while (await iter.next()) {
      const {value} = iter;
      const ns = NameState.decode(value);

      if (ns.data.length <= 0)
        continue;

      const fqdn = util.fqdn(ns.name.toString('ascii'));
      let resource;
      try {
         resource = Resource.decode(ns.data);
      } catch (e) {
        this.logger.warning('Name ' + fqdn + ' uses unsupported serialization format - skipping')
        continue;
      }

      let zone = resource.toZone(fqdn);

      zone = this.pickRRs(fqdn, zone, mergeDB);
      if (zone.length === 0)
        continue;

      const allowRrs = this.allowableRrTypes(zone);

      for (const rr of zone) {

        if ((allowRrs!==null)&&(!allowRrs[rr.type])) continue;

        if (rr.type == types.DS) {
		  const rd = rr.data;
		  if (!(rd.algorithm in algsByVal)) continue;
		  if ((algs.ECC)&&(rd.algorithm == algs.ECC)) continue;
		  }

        if (rr.type === types.RRSIG)
          continue;

        await transfer.writeRR(rr);
        // generate A/AAAA records for _synth.
        if (rr.type === types.NS && rr.data.ns.toLowerCase().endsWith('._synth.'))
          await transfer.writeRR(this.generateSynth(rr.data.ns));

      }
    }

    // merge any remaining data from external zone
    for (const name of mergeDB.nsecChain) {
      const zone = mergeDB.names.get(name).rrs;
      const glues = [];

      for (const rr of zone) {
        // all data is validated just need to remove
        // useless rrs
        if (rr.type === types.NSEC || rr.type === types.RRSIG)
          continue;

        await transfer.writeRR(rr);

        // check for any glue records
        if (rr.type === types.NS && mergeDB.glue.has(rr.data.ns)) {
          const glueData = mergeDB.names.get(rr.data.ns);
          glues.push(glueData.rrs);
          mergeDB.glue.delete(rr.data.ns);
        }
      }

      // write glue
      for (const rrs of glues)
        await transfer.writeAll(rrs);
    }

    await transfer.flush();

    // add SOA since its the last message
    // let hsd write this one
    const res = new Message();
    res.setReply(req);
    res.answer.push(soa);

    this.logger.info(prefix + 'Zone transfer complete');
    return res;
  }

  refuse() {
    const res = new Message();
    res.code = codes.REFUSED;
    return res;
  }

  async loadMergeZone() {
    if(this.disableMerge) {
      return {
        names: new Map(),
        glue: new Set(),
        nsecChain: new Set()
      };
    }

    const data = await this.axfrClient.query('.');
    if (data === null)
      throw new Error('no zone data');

    const validator = new AXFRValidator();
    if (this.ns.icann.isStale())
      await this.ns.icann.refreshKeys();
    return validator.verifyZone(data, this.ns.icann.keyMap);
  }

  open() {
    this.logger.info('AXFR plugin is active');
    this.logger.info('ICANN AXFR Servers: ' + this.icannServers);
    this.logger.info('Allowed IP addresses:', this.ipList.join(', '));
  }

  close() {
  }
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = 'axfr';

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {WalletDB}
 */

plugin.init = function init(node) {
  return new Plugin(node);
};
