'use strict';

var _ = require('underscore');
var async = require('async');
var BlockReward = require('../logic/blockReward.js');
var ByteBuffer = require('bytebuffer');
var constants = require('../helpers/constants.js');
var constants = require('../helpers/constants.js');
var crypto = require('crypto');
var ed = require('ed25519');
var genesisblock = null;
var Inserts = require('../helpers/inserts.js');
var ip = require('ip');
var OrderBy = require('../helpers/orderBy.js');
var Router = require('../helpers/router.js');
var sandboxHelper = require('../helpers/sandbox.js');
var slots = require('../helpers/slots.js');
var sql = require('../sql/blocks.js');
var transactionTypes = require('../helpers/transactionTypes.js');
var util = require('util');

// Private fields
var modules, library, self, __private = {}, shared = {};

__private.lastBlock = {};
__private.lastReceipt = null;
__private.blockReward = new BlockReward();

// @formatter:off
__private.blocksDataFields = {
	'b_id': String,
	'b_version': Number,
	'b_timestamp': Number,
	'b_height': Number,
	'b_previousBlock': String,
	'b_numberOfTransactions': Number,
	'b_totalAmount': String,
	'b_totalFee': String,
	'b_reward': String,
	'b_payloadLength': Number,
	'b_payloadHash': String,
	'b_generatorPublicKey': String,
	'b_blockSignature': String,
	't_id': String,
	't_type': Number,
	't_timestamp': Number,
	't_senderPublicKey': String,
	't_senderId': String,
	't_recipientId': String,
	't_amount': String,
	't_fee': String,
	't_signature': String,
	't_signSignature': String,
	's_publicKey': String,
	'd_username': String,
	'v_votes': String,
	'm_min': Number,
	'm_lifetime': Number,
	'm_keysgroup': String,
	'dapp_name': String,
	'dapp_description': String,
	'dapp_tags': String,
	'dapp_type': Number,
	'dapp_link': String,
	'dapp_category': Number,
	'dapp_icon': String,
	'in_dappId': String,
	'ot_dappId': String,
	'ot_outTransactionId': String,
	't_requesterPublicKey': String,
	't_signatures': String
};
// @formatter:on

__private.loaded = false;
__private.isActive = false;

// Constructor
function Blocks (cb, scope) {
	library = scope;
	genesisblock = library.genesisblock;
	self = this;

	__private.attachApi();

	__private.saveGenesisBlock(function (err) {
		return setImmediate(cb, err, self);
	});
}

// Private methods
__private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) { return next(); }
		res.status(500).send({success: false, error: 'Blockchain is loading'});
	});

	router.map(shared, {
		'get /get': 'getBlock',
		'get /': 'getBlocks',
		'get /getEpoch': 'getEpoch',
		'get /getHeight': 'getHeight',
		'get /getNethash': 'getNethash',
		'get /getFee': 'getFee',
		'get /getFees': 'getFees',
		'get /getMilestone': 'getMilestone',
		'get /getReward': 'getReward',
		'get /getSupply': 'getSupply',
		'get /getStatus': 'getStatus'
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'API endpoint not found'});
	});

	library.network.app.use('/api/blocks', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) { return next(); }
		library.logger.error(req.url, err);
		res.status(500).send({success: false, error: err});
	});
};

__private.saveGenesisBlock = function (cb) {
	library.db.query(sql.getGenesisBlockId, { id: genesisblock.block.id }).then(function (rows) {
		var blockId = rows.length && rows[0].id;

		if (!blockId) {
			__private.saveBlock(genesisblock.block, function (err) {
				return cb(err);
			});
		} else {
			return cb();
		}
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#saveGenesisBlock error');
	});
};

__private.deleteBlock = function (blockId, cb) {
	library.db.none(sql.deleteBlock, { id: blockId }).then(function () {
		return cb();
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#deleteBlock error');
	});
};

__private.list = function (filter, cb) {
	var params = {}, where = [];

	if (filter.generatorPublicKey) {
		where.push('"b_generatorPublicKey"::bytea = ${generatorPublicKey}');
		params.generatorPublicKey = filter.generatorPublicKey;
	}

	if (filter.numberOfTransactions) {
		where.push('"b_numberOfTransactions" = ${numberOfTransactions}');
		params.numberOfTransactions = filter.numberOfTransactions;
	}

	if (filter.previousBlock) {
		where.push('"b_previousBlock" = ${previousBlock}');
		params.previousBlock = filter.previousBlock;
	}

	if (filter.height === 0 || filter.height > 0) {
		where.push('"b_height" = ${height}');
		params.height = filter.height;
	}

	if (filter.totalAmount >= 0) {
		where.push('"b_totalAmount" = ${totalAmount}');
		params.totalAmount = filter.totalAmount;
	}

	if (filter.totalFee >= 0) {
		where.push('"b_totalFee" = ${totalFee}');
		params.totalFee = filter.totalFee;
	}

	if (filter.reward >= 0) {
		where.push('"b_reward" = ${reward}');
		params.reward = filter.reward;
	}

	if (!filter.limit) {
		params.limit = 100;
	} else {
		params.limit = Math.abs(filter.limit);
	}

	if (!filter.offset) {
		params.offset = 0;
	} else {
		params.offset = Math.abs(filter.offset);
	}

	if (params.limit > 100) {
		return cb('Invalid limit. Maximum is 100');
	}

	var orderBy = OrderBy(
		filter.orderBy, {
			sortFields: sql.sortFields,
			fieldPrefix: 'b_'
		}
	);

	if (orderBy.error) {
		return cb(orderBy.error);
	}

	library.db.query(sql.countList({
		where: where
	}), params).then(function (rows) {
		var count = rows[0].count;

		library.db.query(sql.list({
			where: where,
			sortField: orderBy.sortField,
			sortMethod: orderBy.sortMethod
		}), params).then(function (rows) {
			var blocks = [];

			for (var i = 0; i < rows.length; i++) {
				blocks.push(library.logic.block.dbRead(rows[i]));
			}

			var data = {
				blocks: blocks,
				count: count
			};

			return cb(null, data);
		}).catch(function (err) {
			library.logger.error(err.toString());
			return cb('Blocks#list error');
		});
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#list error');
	});
};

__private.getById = function (id, cb) {
	library.db.query(sql.getById, { id: id }).then(function (rows) {
		if (!rows.length) {
			return cb('Block not found');
		}

		var block = library.logic.block.dbRead(rows[0]);

		return cb(null, block);
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#getById error');
	});
};

__private.saveBlock = function (block, cb) {
	library.db.tx(function (t) {
		var promise = library.logic.block.dbSave(block);
		var inserts = new Inserts(promise, promise.values);

		var promises = [
			t.none(inserts.template(), promise.values)
		];

		t = __private.promiseTransactions(t, block, promises);
		t.batch(promises);
	}).then(function () {
		return __private.afterSave(block, cb);
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#saveBlock error');
	});
};

__private.promiseTransactions = function (t, block, blockPromises) {
	if (_.isEmpty(block.transactions)) {
		return t;
	}

	var promises = [];

	var transactionIterator = function (transaction) {
		transaction.blockId = block.id;
		promises = promises.concat(
			library.logic.transaction.dbSave(transaction)
		);
	};

	var promiseGrouper = function (promise) {
		if (promise && promise.table) {
			return promise.table;
		} else {
			throw new Error('Invalid promise');
		}
	};

	var typeIterator = function (type) {
		var values = [];

		_.each(type, function (promise) {
			if (promise && promise.values) {
				values = values.concat(promise.values);
			} else {
				throw new Error('Invalid promise');
			}
		});

		var inserts = new Inserts(type[0], values, true);
		t.none(inserts.template(), inserts);
	};

	_.each(block.transactions, transactionIterator);
	_.each(_.groupBy(promises, promiseGrouper), typeIterator);

	return t;
};

__private.afterSave = function (block, cb) {
	async.eachSeries(block.transactions, function (transaction, cb) {
		return library.logic.transaction.afterSave(transaction, cb);
	}, function (err) {
		return cb(err);
	});
};

__private.popLastBlock = function (oldLastBlock, cb) {
	library.balancesSequence.add(function (cb) {
		self.loadBlocksPart({ id: oldLastBlock.previousBlock }, function (err, previousBlock) {
			if (err || !previousBlock.length) {
				return cb(err || 'previousBlock is null');
			}
			previousBlock = previousBlock[0];

			async.eachSeries(oldLastBlock.transactions.reverse(), function (transaction, cb) {
				async.series([
					function (cb) {
						modules.accounts.getAccount({publicKey: transaction.senderPublicKey}, function (err, sender) {
							if (err) {
								return cb(err);
							}
							modules.transactions.undo(transaction, oldLastBlock, sender, cb);
						});
					}, function (cb) {
						modules.transactions.undoUnconfirmed(transaction, cb);
					}, function (cb) {
						modules.transactions.pushHiddenTransaction(transaction);
						return setImmediate(cb);
					}
				], cb);
			}, function (err) {
				modules.round.backwardTick(oldLastBlock, previousBlock, function () {
					__private.deleteBlock(oldLastBlock.id, function (err) {
						if (err) {
							return cb(err);
						}

						return cb(null, previousBlock);
					});
				});
			});
		});
	}, cb);
};

__private.getIdSequence = function (height, cb) {
	library.db.query(sql.getIdSequence, { height: height, limit: 5, delegates: slots.delegates, activeDelegates: constants.activeDelegates }).then(function (rows) {
		if (rows.length === 0) {
			return cb('Failed to get id sequence before: ' + height);
		}

		var ids = [];

		if (genesisblock && genesisblock.block) {
			var __genesisblock = {
				id: genesisblock.block.id,
				height: genesisblock.block.height
			};

			if (!_.contains(rows, __genesisblock.id)) {
				rows.push(__genesisblock);
			}
		}

		if (__private.lastBlock && !_.contains(rows, __private.lastBlock.id)) {
			rows.unshift({
				id: __private.lastBlock.id,
				height: __private.lastBlock.height
			});
		}

		rows.forEach(function (row) {
			if (!_.contains(ids, row.id)) {
				ids.push('\'' + row.id + '\'');
			}
		});

		return cb(null, { firstHeight: rows[0].height, ids: ids.join(',') });
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#getIdSequence error');
	});
};

__private.readDbRows = function (rows) {
	var blocks = {};
	var order = [];

	for (var i = 0, length = rows.length; i < length; i++) {
		var __block = library.logic.block.dbRead(rows[i]);

		if (__block) {
			if (!blocks[__block.id]) {
				if (__block.id === genesisblock.block.id) {
					__block.generationSignature = (new Array(65)).join('0');
				}

				order.push(__block.id);
				blocks[__block.id] = __block;
			}

			var __transaction = library.logic.transaction.dbRead(rows[i]);
			blocks[__block.id].transactions = blocks[__block.id].transactions || {};

			if (__transaction) {
				if (!blocks[__block.id].transactions[__transaction.id]) {
					blocks[__block.id].transactions[__transaction.id] = __transaction;
				}
			}
		}
	}

	blocks = order.map(function (v) {
		blocks[v].transactions = Object.keys(blocks[v].transactions).map(function (t) {
			return blocks[v].transactions[t];
		});
		return blocks[v];
	});

	return blocks;
};

__private.applyTransaction = function (block, transaction, sender, cb) {
	modules.transactions.applyUnconfirmed(transaction, sender, function (err) {
		if (err) {
			return setImmediate(cb, {
				message: err,
				transaction: transaction,
				block: block
			});
		}

		modules.transactions.apply(transaction, block, sender, function (err) {
			if (err) {
				return setImmediate(cb, {
					message: 'Can\'t apply transaction: ' + transaction.id,
					transaction: transaction,
					block: block
				});
			}
			return setImmediate(cb);
		});
	});
};

// Public methods
Blocks.prototype.lastReceipt = function (lastReceipt) {
	if (lastReceipt) {
		__private.lastReceipt = lastReceipt;
	}

	return __private.lastReceipt;
};

Blocks.prototype.getCommonBlock = function (peer, height, cb) {
	var commonBlock = null;
	var lastBlockHeight = height;
	var count = 0;

	async.whilst(
		function () {
			return !commonBlock && count < 30 && lastBlockHeight > 1;
		},
		function (next) {
			count++;
			__private.getIdSequence(lastBlockHeight, function (err, data) {
				if (err) {
					return next(err);
				}

				modules.transport.getFromPeer(peer, {
					api: '/blocks/common?ids=' + data.ids,
					method: 'GET'
				}, function (err, data) {
					if (err || data.body.error) {
						return next(err || data.body.error.toString());
					}

					if (!data.body.common) {
						return next();
					}

					library.db.query(sql.getCommonBlock(data.body.common.previousBlock), {
						id: data.body.common.id,
						previousBlock: data.body.common.previousBlock,
						height: data.body.common.height
					}).then(function (rows) {
						if (!rows.length) {
							return next('Chain comparison failed with peer: ' + peer.string);
						}

						if (rows[0].count) {
							commonBlock = data.body.common;
						}

						return next();
					}).catch(function (err) {
						library.logger.error(err.toString());
						return next('Blocks#getCommonBlock error');
					});
				});
			});
		},
		function (err) {
			return setImmediate(cb, err, commonBlock);
		}
	);
};

Blocks.prototype.count = function (cb) {
	library.db.query(sql.countByRowId).then(function (rows) {
		var res = rows.length ? rows[0].count : 0;

		return cb(null, res);
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#count error');
	});
};

Blocks.prototype.loadBlocksData = function (filter, options, cb) {
	if (arguments.length < 3) {
		cb = options;
		options = {};
	}

	options = options || {};

	if (filter.lastId && filter.id) {
		return cb('Invalid filter');
	}

	var params = { limit: filter.limit || 1 };

	if (filter.lastId) {
		params.lastId = filter.lastId;
	}

	if (filter.id && !filter.lastId) {
		params.id = filter.id;
	}

	var fields = __private.blocksDataFields;

	library.dbSequence.add(function (cb) {
		library.db.query(sql.getHeightByLastId, { lastId: filter.lastId || null }).then(function (rows) {

			var height = rows.length ? rows[0].height : 0;
			var realLimit = height + (parseInt(filter.limit) || 1);

			params.limit = realLimit;
			params.height = height;

			library.db.query(sql.loadBlocksData(filter), params).then(function (rows) {
				return cb(null, rows);
			});
		}).catch(function (err ) {
			library.logger.error(err.toString());
			return cb('Blocks#loadBlockData error');
		});
	}, cb);
};

Blocks.prototype.loadBlocksPart = function (filter, cb) {
	self.loadBlocksData(filter, function (err, rows) {
		// Notes:
		// If while loading we encounter an error, for example, an invalid signature on a block & transaction, then we need to stop loading and remove all blocks after the last good block. We also need to process all transactions within the block.

		var blocks = [];

		if (!err) {
			blocks = __private.readDbRows(rows);
		}

		return cb(err, blocks);
	});
};

Blocks.prototype.loadBlocksOffset = function (limit, offset, verify, cb) {
	var newLimit = limit + (offset || 0);
	var params = { limit: newLimit, offset: offset || 0 };

	library.logger.debug('loadBlocksOffset', { limit: limit, offset: offset, verify: verify });
	library.dbSequence.add(function (cb) {
		library.db.query(sql.loadBlocksOffset, params).then(function (rows) {
			var blocks = __private.readDbRows(rows);

			async.eachSeries(blocks, function (block, cb) {
				library.logger.debug('Processing block:', block.id);
				if (verify && block.id !== genesisblock.block.id) {
					// Sanity check of the block, if values are coherent.
					// No access to database.
					var check = self.verifyBlock(block);

					if (!check.verified) {
						library.logger.error('Block is erroneous:', check.errors);
						return setImmediate(cb, check.errors[0]);
					}
				}
				if (block.id === genesisblock.block.id) {
					__private.applyGenesisBlock(block, cb);
				} else {
					__private.applyBlock(block, false, cb, false);
				}
			}, function (err) {
				return setImmediate(cb, err);
			});
		}).catch(function (err) {
			// Notes:
			// If while loading we encounter an error, for example, an invalid signature on a block & transaction, then we need to stop loading and remove all blocks after the last good block. We also need to process all transactions within the block.
			library.logger.error(err.toString());
			return cb('Blocks#loadBlocksOffset error');
		});
	}, cb);
};

Blocks.prototype.getLastBlock = function () {
	return __private.lastBlock;
};

// Will return all possible errors that are intrinsic to the block.
// NO DATABASE access
Blocks.prototype.verifyBlock = function (block) {
	var result = { verified: false, errors: [] };

	try {
		block.id = library.logic.block.getId(block);
	} catch (e) {
		result.errors.push(e.toString());
	}

	block.height = __private.lastBlock.height + 1;

	if (!block.previousBlock && block.height !== 1) {
		result.errors.push('Invalid previous block');
	}

	var expectedReward = __private.blockReward.calcReward(block.height);

	if (block.height !== 1 && expectedReward !== block.reward) {
		result.errors.push('Invalid block reward');
	}

	var valid;

	try {
		valid = library.logic.block.verifySignature(block);
	} catch (e) {
		result.errors.push(e.toString());
	}

	if (!valid) {
		result.errors.push('Can\'t verify signature: ' + block.id);
	}

	if (block.previousBlock !== __private.lastBlock.id) {
		// Fork: Same height but different previous block id.
		modules.delegates.fork(block, 1);
		result.errors.push('Can\'t verify previous block: ' + block.id);
	}

	if (block.version > 0) {
		result.errors.push('Invalid block version: ' + block.id);
	}

	var blockSlotNumber = slots.getSlotNumber(block.timestamp);
	var lastBlockSlotNumber = slots.getSlotNumber(__private.lastBlock.timestamp);

	if (blockSlotNumber > slots.getSlotNumber() || blockSlotNumber <= lastBlockSlotNumber) {
		result.errors.push('Can\'t verify block timestamp: ' + block.id);
	}

	if (block.payloadLength > constants.maxPayloadLength) {
		result.errors.push('Can\'t verify payload length of block: ' + block.id);
	}

	if (block.transactions.length !== block.numberOfTransactions || block.transactions.length > constants.maxTxsPerBlock) {
		result.errors.push('Invalid amount of block assets: ' + block.id);
	}

	// Checking if transactions of the block adds up to block values.
	var totalAmount = 0,
	    totalFee = 0,
	    payloadHash = crypto.createHash('sha256'),
	    appliedTransactions = {};

	for (var i in block.transactions) {
		var transaction = block.transactions[i];
		var bytes;

		try {
			bytes = library.logic.transaction.getBytes(transaction);
		} catch (e) {
			result.errors.push(e.toString());
		}

		if (appliedTransactions[transaction.id]) {
			result.errors.push('Duplicate transaction id in block ' + block.id);
		}

		appliedTransactions[transaction.id] = transaction;
		payloadHash.update(bytes);
		totalAmount += transaction.amount;
		totalFee += transaction.fee;
	}

	if (payloadHash.digest().toString('hex') !== block.payloadHash) {
		result.errors.push('Invalid payload hash: ' + block.id);
	}

	if (totalAmount !== block.totalAmount) {
		result.errors.push('Invalid total amount: ' + block.id);
	}

	if (totalFee !== block.totalFee) {
		result.errors.push('Invalid total fee: ' + block.id);
	}

	result.verified = result.errors.length === 0;
	return result;
};

// Apply the block, provided it has been verified.
__private.applyBlock = function (block, broadcast, cb, saveBlock) {
	// Don't shut the node right now as it might kill the database state.
	__private.isActive = true;

	library.balancesSequence.add(function (cb) {
		// Pop current unconfirmed transactions list before applying block.
		// To remove the applied transactions in the block if present.
		// TODO: It should be possible to remove this call if we can guarantee that only this function is processing transactions atomically. Then speed should be improved further.
		// TODO: Other possibility, when we rebuild from block chain this action should be moved out of the rebuild function.
		// DATABASE write
		modules.transactions.undoUnconfirmedList(function (err, unconfirmedTransactions) {
			if (err) {
				__private.isActive = false;
				// TODO: Send a numbered signal to be caught by forever to trigger a rebuild.
				return process.exit(0);
			}

			// Called later on when the process has finished (correctly or with errors).
			function done(err) {
				// Push back unconfirmed transactions list (minus the one that were on the block if applied correctly).
				// TODO: See undoUnconfirmedList discussion above.
				// DATABASE write
				modules.transactions.applyUnconfirmedList(unconfirmedTransactions, function () {
					__private.isActive = false;
					return setImmediate(cb, err);
				});
			}

			// Transactions to rewind in case of error.
			// TODO: When rebuilding we could get rid off this because transactions are all supposedly verified.
			// TODO: No great speed improvement expected.
			var appliedTransactions = {};

			async.eachSeries(block.transactions, function (transaction, cb) {
				modules.accounts.setAccountAndGet({publicKey: transaction.senderPublicKey}, function (err, sender) {
					// If it fails we need to rewind the previous applied transactions of the blocks in appliedTransactions.
					// DATABASE: write. Apply transaction to mem_accounts u_* fields
					modules.transactions.applyUnconfirmed(transaction, sender, function (err) {
						if (err) {
							library.logger.error( 'Failed to apply transaction: ' + transaction.id + ' - error: ' + err);
							return setImmediate(cb, 'Failed to apply transaction: ' + transaction.id + ' - error: ' + err);
						}
						appliedTransactions[transaction.id] = transaction;

						// Remove the transaction from the node queue, if it was present.
						var index = unconfirmedTransactions.indexOf(transaction.id);
						if (index >= 0) {
							unconfirmedTransactions.splice(index, 1);
						}

						return setImmediate(cb);
					});
				});
			}, function (err) {
				if (err) {
					// Rewind the already applied transactions of the block to leave the database in the state of the previous block.
					// In case of rebuilding, this should never happen. Optimising here is meaningless.
					async.eachSeries(block.transactions, function (transaction, cb) {
						modules.accounts.getAccount({publicKey: transaction.senderPublicKey}, function (err, sender) {
							// The transaction has been applied?
							if (appliedTransactions[transaction.id]) {
								// DATABASE: write
								library.logic.transaction.undoUnconfirmed(transaction, sender, cb);
							} else {
								return setImmediate(cb);
							}
						});
					}, function (err) {
						done(err);
					});
				} else {
					// Everything is ok now we apply the unconfirmed to confirmed.
					async.eachSeries(block.transactions, function (transaction, cb) {
						// TODO: To be optimised because even if publicKey is already present in db, the write call is done anyway.
						// DATABASE: write
						modules.accounts.setAccountAndGet({publicKey: transaction.senderPublicKey}, function (err, sender) {
							if (err) {
								library.logger.error('Failed to apply transactions: ' + transaction.id);
								// TODO: Send a numbered signal to be caught by forever to trigger a rebuild.
								process.exit(0);
							}
							// DATABASE: write
							modules.transactions.apply(transaction, block, sender, function (err) {
								if (err) {
									library.logger.error('Failed to apply transactions: ' + transaction.id);
									// TODO: Send a numbered signal to be caught by forever to trigger a rebuild.
									process.exit(0);
								}
								// Transaction applied, removed from the unconfirmed list.
								// In memory list, no database access
								modules.transactions.removeUnconfirmedTransaction(transaction.id);
								return setImmediate(cb);
							});
						});
					}, function (err) {
						__private.lastBlock = block;
						// Save the block into the database.
						// DATABASE: write
						if (saveBlock) {
							__private.saveBlock(block, function (err) {
							 if (err) {
								 library.logger.error('Failed to save block...');
								 // TODO: Send a numbered signal to be caught by forever to trigger a normal restart (i.e. restarting the db).
								 process.exit(0);
							 }

							 library.logger.debug('Block applied corrrectly with ' + block.transactions.length + ' transactions');
							 library.bus.message('newBlock', block, broadcast);
							 // DATABASE write. Update delegates accounts
							 modules.round.tick(block, done);
						 });
						} else {
							library.bus.message('newBlock', block, broadcast);
							// DATABASE write. Update delegates accounts
							modules.round.tick(block, done);
						}
					});
				}
			});
		});
	}, cb);
};

// Apply the genesis block, provided it has been verified.
// Shortcuting the unconfirmed/confirmed states.
__private.applyGenesisBlock = function (block, cb) {
	block.transactions = block.transactions.sort(function (a, b) {
		if (a.type === transactionTypes.VOTE) {
			return 1;
		} else {
			return 0;
		}
	});
	async.eachSeries(block.transactions, function (transaction, cb) {
			modules.accounts.setAccountAndGet({publicKey: transaction.senderPublicKey}, function (err, sender) {
				if (err) {
					return cb({
						message: err,
						transaction: transaction,
						block: block
					});
				}
				__private.applyTransaction(block, transaction, sender, cb);
			});
	}, function (err) {
		if (err) {
			// If genesis block is invalid, kill the node...
			return process.exit(0);
		} else {
			__private.lastBlock = block;
			modules.round.tick(__private.lastBlock, cb);
		}
	});
};

// Main function to process a Block.
// * Verify the block looks ok
// * Verify the block is compatible with database state (DATABASE readonly)
// * Apply the block to database if both verifications are ok
Blocks.prototype.processBlock = function (block, broadcast, cb, saveBlock) {
	if (!__private.loaded) {
		return setImmediate(cb, 'Blockchain is loading');
	}

	try {
		block = library.logic.block.objectNormalize(block);
	} catch (err) {
		return setImmediate(cb, err);
	}

	// Sanity check of the block, if values are coherent.
	// No access to database
	var check = self.verifyBlock(block);

	if (!check.verified) {
		library.logger.error('Block is erroneous: ', check.errors);
		return setImmediate(cb, check.errors[0]);
	}

	// Check if block id is already in the database (very low probability of hash collision).
	// TODO: In case of hash-collision, to me it would be a special autofork...
	// DATABASE: read only
	library.db.query(sql.getBlockId, { id: block.id }).then(function (rows) {
		if (rows.length > 0) {
			return setImmediate(cb, 'Block already exists: ' + block.id);
		}

		// Check if block was generated by the right active delagate. Otherwise, fork 3.
		// DATABASE: Read only to mem_accounts to extract active delegate list
		modules.delegates.validateBlockSlot(block, function (err) {
			if (err) {
				modules.delegates.fork(block, 3);
				return setImmediate(cb, err);
			}

			// Check against the mem_* tables that we can perform the transactions included in the block.
			async.eachSeries(block.transactions, function (transaction, cb) {
				async.waterfall([
					function (callback) {
						try {
							transaction.id = library.logic.transaction.getId(transaction);
						} catch (e) {
							return callback(e.toString());
						}
						transaction.blockId = block.id;
						// Check if transaction is already in database, otherwise fork 2.
						// DATABASE: read only
						library.db.query(sql.getTransactionId, { id: transaction.id }).then(function (rows) {
							if (rows.length > 0) {
								modules.delegates.fork(block, 2);
								callback('Transaction already exists: ' + transaction.id);
							} else {
								// Get account from database if any (otherwise cold wallet).
								// DATABASE: read only
								modules.accounts.getAccount({publicKey: transaction.senderPublicKey}, callback);
							}
						}).catch(function (err) {
							callback('Blocks#processBlock error: ' + err.toString());
						});
					},
					function (sender, callback) {
						// Check if transaction id valid against database state (mem_* tables).
						// DATABASE: read only
						library.logic.transaction.verify(transaction, sender, callback);
					}
				],
				function (err) {
					return cb(err);
				});
			},
			function (err) {
				if (err) {
					return setImmediate(cb, err);
				} else {
					// The block and the transactions are OK i.e:
					// * Block and transactions have valid values (signatures, block slots, etc...)
					// * The check against database state passed (for instance sender has enough LSK, votes are under 101, etc...)
					// We thus update the database with the transactions values, save the block and tick it.
					__private.applyBlock(block, broadcast, cb, saveBlock);
				}
			});
		});
	});
};

Blocks.prototype.simpleDeleteAfterBlock = function (blockId, cb) {
	library.db.query(sql.simpleDeleteAfterBlock, { id: blockId }).then(function (res) {
		return cb(null, res);
	}).catch(function (err) {
		library.logger.error(err.toString());
		return cb('Blocks#simpleDeleteAfterBlock error');
	});
};

Blocks.prototype.loadBlocksFromPeer = function (peer, callback) {
	var lastValidBlock = __private.lastBlock;

	peer = modules.peer.inspect(peer);
	library.logger.info('Loading blocks from', peer.string);

	modules.transport.getFromPeer(peer, {
		method: 'GET',
		api: '/blocks?lastBlockId=' + lastValidBlock.id
	}, function (err, data) {
		if (err || data.body.error) {
			return setImmediate(callback, err, lastValidBlock);
		}

		var blocks = data.body.blocks;

		var report = library.scheme.validate(blocks, {
			type: 'array'
		});

		if (!report) {
			return setImmediate(callback, 'Received invalid blocks data', lastValidBlock);
		}

		blocks = __private.readDbRows(blocks);

		if (blocks.length === 0) {
			return setImmediate(callback, null, lastValidBlock);
		} else {
			async.eachSeries(blocks, function (block, cb) {
				self.processBlock(block, false, function (err) {
					if (!err) {
						var lastCommonBlockId = block.id;
						lastValidBlock = block;
						library.logger.info('Block ' + block.id + ' loaded from ' + peer.string + ' at', block.height);
					} else {
						library.logger.warn('Block ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peer.string);
						library.logger.warn(err.toString());
						modules.peer.state(peer.ip, peer.port, 0, 3600);
					}
					return cb(err);
				});
			}, function (err) {
				if (err) {
					return setImmediate(callback, 'Error loading blocks: ' + err, lastValidBlock);
				}
				return setImmediate(callback, null, lastValidBlock);
			});
		}
	});
};

Blocks.prototype.deleteBlocksBefore = function (block, cb) {
	var blocks = [];

	async.whilst(
		function () {
			return (block.height < __private.lastBlock.height);
		},
		function (next) {
			blocks.unshift(__private.lastBlock);
			__private.popLastBlock(__private.lastBlock, function (err, newLastBlock) {
				__private.lastBlock = newLastBlock;
				next(err);
			});
		},
		function (err) {
			return setImmediate(cb, err, blocks);
		}
	);
};

Blocks.prototype.generateBlock = function (keypair, timestamp, cb) {
	var transactions = modules.transactions.getUnconfirmedTransactionList(false, constants.maxTxsPerBlock);
	var ready = [];

	async.eachSeries(transactions, function (transaction, cb) {
		modules.accounts.getAccount({ publicKey: transaction.senderPublicKey }, function (err, sender) {
			if (err || !sender) {
				return setImmediate(cb, 'Invalid sender');
			}

			if (library.logic.transaction.ready(transaction, sender)) {
				library.logic.transaction.verify(transaction, sender, function (err) {
					ready.push(transaction);
					return setImmediate(cb);
				});
			} else {
				return setImmediate(cb);
			}
		});
	}, function () {
		var block;

		try {
			block = library.logic.block.create({
				keypair: keypair,
				timestamp: timestamp,
				previousBlock: __private.lastBlock,
				transactions: ready
			});
		} catch (e) {
			library.logger.error(e.toString());
			return setImmediate(cb, e);
		}

		self.processBlock(block, true, cb, true);
	});
};

Blocks.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
};

// Events
Blocks.prototype.onReceiveBlock = function (block) {
	// When client is not loaded, is syncing or round is ticking
	// Do not receive new blocks as client is not ready to receive them
	if (!__private.loaded || modules.loader.syncing() || modules.round.ticking()) {
		library.logger.debug('onReceiveBlock:', 'client not ready');
		return;
	}

	library.sequence.add(function (cb) {
		if (block.previousBlock === __private.lastBlock.id && __private.lastBlock.height + 1 === block.height) {
			library.logger.info('Received new block id: ' + block.id + ' height: ' + block.height + ' round: ' + modules.round.calc(modules.blocks.getLastBlock().height) + ' slot: ' + slots.getSlotNumber(block.timestamp) + ' reward: ' + modules.blocks.getLastBlock().reward);
			self.lastReceipt(new Date());
			self.processBlock(block, true, cb, true);
		} else if (block.previousBlock !== __private.lastBlock.id && __private.lastBlock.height + 1 === block.height) {
			// Fork: Same height but different previous block id
			modules.delegates.fork(block, 1);
			return cb('Fork');
		} else if (block.previousBlock === __private.lastBlock.previousBlock && block.height === __private.lastBlock.height && block.id !== __private.lastBlock.id) {
			// Fork: Same height and previous block id, but different block id
			modules.delegates.fork(block, 5);
			return cb('Fork');
		} else {
			return cb();
		}
	});
};

Blocks.prototype.onBind = function (scope) {
	modules = scope;

	__private.loaded = true;
};

Blocks.prototype.cleanup = function (cb) {
	__private.loaded = false;
	if (!__private.isActive) {
		return cb();
	} else {
		setImmediate(function nextWatch () {
			if (__private.isActive) {
				setTimeout(nextWatch, 1 * 1000);
			} else {
				return cb();
			}
		});
	}
};

// Shared
shared.getBlock = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	library.scheme.validate(query, {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				minLength: 1
			}
		},
		required: ['id']
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		library.dbSequence.add(function (cb) {
			__private.getById(query.id, function (err, block) {
				if (!block || err) {
					return cb('Block not found');
				}
				return cb(null, {block: block});
			});
		}, cb);
	});
};

shared.getBlocks = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	library.scheme.validate(query, {
		type: 'object',
		properties: {
			limit: {
				type: 'integer',
				minimum: 0,
				maximum: 100
			},
			orderBy: {
				type: 'string'
			},
			offset: {
				type: 'integer',
				minimum: 0
			},
			generatorPublicKey: {
				type: 'string',
				format: 'publicKey'
			},
			totalAmount: {
				type: 'integer',
				minimum: 0,
				maximum: constants.totalAmount
			},
			totalFee: {
				type: 'integer',
				minimum: 0,
				maximum: constants.totalAmount
			},
			reward: {
				type: 'integer',
				minimum: 0
			},
			previousBlock: {
				type: 'string'
			},
			height: {
				type: 'integer'
			}
		}
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		library.dbSequence.add(function (cb) {
			__private.list(query, function (err, data) {
				if (err) {
					return cb(err);
				}
				return cb(null, {blocks: data.blocks, count: data.count});
			});
		}, cb);
	});
};

shared.getEpoch = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	return cb(null, {epoch: constants.epochTime});
};

shared.getHeight = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	return cb(null, {height: __private.lastBlock.height});
};

shared.getFee = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	return cb(null, {fee: library.logic.block.calculateFee()});
};

shared.getFees = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	return cb(null, {fees: constants.fees});
};

shared.getNethash = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body;

	return cb(null, {nethash: library.config.nethash});
};

shared.getMilestone = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body, height = __private.lastBlock.height;

	return cb(null, {milestone: __private.blockReward.calcMilestone(height)});
};

shared.getReward = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body, height = __private.lastBlock.height;

	return cb(null, {reward: __private.blockReward.calcReward(height)});
};

shared.getSupply = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body, height = __private.lastBlock.height;

	return cb(null, {supply: __private.blockReward.calcSupply(height)});
};

shared.getStatus = function (req, cb) {
	if (!__private.loaded) {
		return cb('Blockchain is loading');
	}

	var query = req.body, height = __private.lastBlock.height;

	return cb(null, {
		epoch:     constants.epochTime,
		height:    height,
		fee:       library.logic.block.calculateFee(),
		milestone: __private.blockReward.calcMilestone(height),
		nethash:   library.config.nethash,
		reward:    __private.blockReward.calcReward(height),
		supply:    __private.blockReward.calcSupply(height)
	});
};

// Export
module.exports = Blocks;
