import {ValidationError} from '../../errors.js';
import {mobileId} from './mobile-telemetry.js';

export class MobileRuns {
  constructor(mobile) {this.mobile = mobile;this.sql = mobile.sql;}
  request(id) {
    if (!mobileId(id)) throw new ValidationError('Некорректный номер запуска Android.');
    const device = this.sql.prepare('SELECT token_hash FROM mobile_device WHERE id=1').get();
    if (!device) throw new ValidationError('Телефон не подключён.');
    const now = new Date(this.mobile.current()).toISOString();
    this.sql.prepare("INSERT OR IGNORE INTO mobile_runs(id,device_hash,state,created_at,updated_at) VALUES(?,?,'requested',?,?)").run(id,device.token_hash,now,now);
    const row = this.get(id);
    if (row.device_hash !== device.token_hash) throw new ValidationError('Запуск относится к прежнему подключению.');
    return row;
  }
  get(id) {return this.sql.prepare('SELECT * FROM mobile_runs WHERE id=?').get(id);}
  link(id,operation,check = null) {
    this.sql.prepare("UPDATE mobile_runs SET operation_id=?,check_id=?,state='active',updated_at=? WHERE id=? AND state='requested' AND operation_id IS NULL")
      .run(operation,check,new Date(this.mobile.current()).toISOString(),id);
    return this.get(id);
  }
  bind(operation,check) {this.sql.prepare("UPDATE mobile_runs SET check_id=? WHERE operation_id=? AND state='active'").run(check,operation);}
  finish(operation,state) {
    this.sql.prepare("UPDATE mobile_runs SET state=?,updated_at=? WHERE operation_id=? AND state='active'").run(state,new Date(this.mobile.current()).toISOString(),operation);
  }
  end(id,state) {this.sql.prepare('UPDATE mobile_runs SET state=?,updated_at=? WHERE id=?').run(state,new Date(this.mobile.current()).toISOString(),id);}
  cancel(id) {
    const row = this.request(id);
    const completed = row.check_id && this.sql.prepare('SELECT status FROM checks WHERE id=?').get(row.check_id)?.status === 'success';
    const outcome = completed || row.state === 'completed' ? 'completed' : ['ended','failed','idle'].includes(row.state) ? 'ended' : 'canceled';
    this.end(id,outcome);return {...this.get(id),outcome};
  }
}
