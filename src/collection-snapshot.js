// Keep the published dashboard available while a collector writes its next result.
// Stored in SQLite so HTTP and CLI collectors share the same boundary.
export class CollectionSnapshot {
  constructor(db,{scopes,build,sellers = false}) {
    Object.assign(this,{db,scopes,build,sellers});
    db.exec(`CREATE TABLE IF NOT EXISTS collection_snapshot(
      scope TEXT PRIMARY KEY,boundary TEXT NOT NULL,payload TEXT NOT NULL)`);
  }
  running() {return !!this.db.prepare("SELECT 1 FROM checks WHERE status='running' LIMIT 1").get();}
  start(action) {
    this.db.exec('SAVEPOINT collection_snapshot_start');
    try {
      if (!this.running()) {
        const boundary = {maxId:this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM observations').get().id};
        if (this.sellers) boundary.maxSellerId = this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM seller_events').get().id;
        const write = this.db.prepare('INSERT OR REPLACE INTO collection_snapshot VALUES(?,?,?)');
        for (const scope of this.scopes) write.run(scope,JSON.stringify(boundary),JSON.stringify(this.build(scope)));
      }
      const result = action();
      this.db.exec('RELEASE collection_snapshot_start');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO collection_snapshot_start; RELEASE collection_snapshot_start');
      throw error;
    }
  }
  saved(scope) {
    const row = this.db.prepare('SELECT * FROM collection_snapshot WHERE scope=?').get(scope);
    if (!row) throw new Error('Предыдущий результат недоступен до завершения текущего сбора.');
    return {boundary:JSON.parse(row.boundary),data:JSON.parse(row.payload)};
  }
  dashboard(scope) {
    return this.read(() => this.running() ? this.saved(scope).data : this.build(scope));
  }
  detail(id,build) {
    return this.read(() => {
      if (!this.running()) return build({});
      const {boundary} = this.saved(this.scopes[0]);
      for (const scope of this.scopes) {
        const product = this.saved(scope).data.items.find(item => item.id === id);
        if (product) return build({...boundary,product});
      }
      return build(boundary);
    });
  }
  read(action) {
    // A CLI collector can start/finish between SQL statements in an HTTP read.
    this.db.exec('SAVEPOINT collection_snapshot_read');
    try {
      const result = action();
      this.db.exec('RELEASE collection_snapshot_read');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO collection_snapshot_read; RELEASE collection_snapshot_read');
      throw error;
    }
  }
}
