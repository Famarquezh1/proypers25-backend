const { FieldValue } = require('firebase-admin/firestore');

const SNAPSHOT_COLLECTION = 'market_microstructure_snapshots';
const SNAPSHOT_PUBLISH_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.MARKET_STREAM_SNAPSHOT_PUBLISH_INTERVAL_MS || 15000)
);

class MarketSnapshotPublisher {
  constructor() {
    this.lastPublished = new Map();
  }

  shouldPublish(symbol, snapshot, options = {}) {
    if (!snapshot || !symbol) return false;
    const intervalMs = Math.max(
      1000,
      Number(options.intervalMs || SNAPSHOT_PUBLISH_INTERVAL_MS)
    );
    const now = Date.now();
    const previous = this.lastPublished.get(symbol);
    if (!previous || now - previous.at >= intervalMs) return true;

    const priceDelta = Math.abs(Number(snapshot.last_price || 0) - Number(previous.snapshot?.last_price || 0));
    const spreadDelta = Math.abs(Number(snapshot.spread_bps || 0) - Number(previous.snapshot?.spread_bps || 0));
    const imbalanceDelta = Math.abs(
      Number(snapshot.trade_flow_imbalance || 0) - Number(previous.snapshot?.trade_flow_imbalance || 0)
    );

    return priceDelta > 0 || spreadDelta >= 0.5 || imbalanceDelta >= 0.05;
  }

  async publishSnapshot(db, symbol, snapshot, options = {}) {
    if (!db || !symbol || !snapshot) return false;
    if (!this.shouldPublish(symbol, snapshot, options)) return false;

    await db.collection(SNAPSHOT_COLLECTION).doc(String(symbol).toUpperCase()).set(
      {
        symbol: String(symbol).toUpperCase(),
        snapshot,
        source: 'market_stream_worker',
        published_at: new Date().toISOString(),
        updated_at: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    this.lastPublished.set(String(symbol).toUpperCase(), {
      at: Date.now(),
      snapshot
    });
    return true;
  }
}

const marketSnapshotPublisher = new MarketSnapshotPublisher();

module.exports = {
  SNAPSHOT_COLLECTION,
  MarketSnapshotPublisher,
  marketSnapshotPublisher
};
