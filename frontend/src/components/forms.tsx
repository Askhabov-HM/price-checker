import {useState, type FormEvent} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {invalidatePrices, mutate} from '@/lib/api';
import type {ScheduleSettings, Status} from '@/lib/types';
import {RandewooConnection} from './randewoo-connection';
import {ScheduleFields} from './schedule-fields';
import {invalidateOzon, ozonMutate} from '@/lib/ozon';
import type {OzonStatus} from '@/lib/ozon';

export function AddDialog({open, onClose, destination = 'watching'}: {open: boolean; onClose: () => void; destination?: 'watching' | 'my-cart'}) {
  return <Dialog open={open} onOpenChange={value => {if (!value) onClose();}}>{open && <AddForm destination={destination} onClose={onClose} />}</Dialog>;
}
function AddForm({onClose, destination}: {onClose: () => void; destination: 'watching' | 'my-cart'}) {
  const [url, setUrl] = useState('');
  const add = useMutation({mutationFn: () => mutate(destination === 'my-cart' ? '/api/my-cart/add' : '/api/watch/add', {url}), onSuccess: async () => {await invalidatePrices(); onClose();}});
  return <DialogContent className="sm:max-w-[560px]"><DialogHeader><DialogTitle>{destination === 'my-cart' ? 'Добавить в мою корзину' : 'Добавить в наблюдение'}</DialogTitle><DialogDescription>Найдём варианты 1,5 мл и сохраним их текущие цены.</DialogDescription></DialogHeader><form id="add-form" onSubmit={event => {event.preventDefault(); add.mutate();}} className="grid gap-4"><Label htmlFor="add-url">Ссылка на товар Randewoo</Label><Input id="add-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://randewoo.ru/product/…" />{add.error && <p role="alert">{add.error.message}</p>}<div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button id="add-submit" type="submit" disabled={add.isPending}>{add.isPending ? 'Получаем цену…' : 'Добавить товар'}</Button></div></form></DialogContent>;
}
export function SettingsDialog({status, open, onClose}: {status?: Status; open: boolean; onClose: () => void}) {
  return <Dialog open={open} onOpenChange={value => {if (!value) onClose();}}>{open && status && <SettingsForm status={status} onClose={onClose} />}</Dialog>;
}
function SettingsForm({status, onClose}: {status: Status; onClose: () => void}) {
  const [schedule, setSchedule] = useState<ScheduleSettings>({schedule:status.schedule,schedule_enabled:status.schedule_enabled,
    schedule_mode:status.schedule_mode ?? 'hours',interval_minutes:status.interval_minutes ?? 30});
  // Session fields are transient and are destroyed when the dialog closes.
  const [cookie, setCookie] = useState(''), [agent, setAgent] = useState(navigator.userAgent);
  const save = useMutation({
    mutationFn: async () => {
      await mutate('/api/settings', schedule);
      if (cookie.trim()) await mutate('/api/session', {cookie, user_agent: agent});
    },
    onSuccess: async () => {setCookie(''); await invalidatePrices(); onClose();},
  });
  const submit = (event: FormEvent) => {event.preventDefault(); save.mutate();};
  return <DialogContent id="settings-dialog" className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]"><DialogHeader><DialogTitle>Настройки Randewoo</DialogTitle><DialogDescription>Изменения применяются только к Randewoo. Расписание Ozon сохраняется отдельно.</DialogDescription></DialogHeader><form id="settings-form" onSubmit={submit} className="grid gap-4">
    <ScheduleFields value={schedule} onChange={setSchedule} prefix="randewoo" disabled={save.isPending}/>
    <details><summary className="cursor-pointer text-sm text-primary">Обновить данные авторизации</summary><div className="mt-4 grid gap-3"><p className="text-xs text-muted-foreground">Заголовки Cookie и User-Agent из своего запроса /cart в DevTools. Значения сохраняются только локально.</p><Label htmlFor="session-cookie">Cookie</Label><Input id="session-cookie" type="password" autoComplete="off" spellCheck={false} value={cookie} onChange={event => setCookie(event.target.value)} /><Label htmlFor="session-agent">User-Agent</Label><Input id="session-agent" value={agent} onChange={event => setAgent(event.target.value)} /></div></details>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</Button></div>
  </form><RandewooConnection message={status.auth_message} /></DialogContent>;
}

export function OzonSettingsDialog({status,open,onClose}: {status?: OzonStatus; open: boolean; onClose: () => void}) {
  return <Dialog open={open} onOpenChange={value => {if (!value) onClose();}}>{open && status && <OzonSettingsForm status={status} onClose={onClose}/>}</Dialog>;
}
function OzonSettingsForm({status,onClose}: {status: OzonStatus; onClose: () => void}) {
  const [schedule,setSchedule] = useState<ScheduleSettings>({schedule:status.schedule ?? ['00:00'],schedule_enabled:status.schedule_enabled,
    schedule_mode:status.schedule_mode ?? 'interval',interval_minutes:status.interval_minutes});
  const save = useMutation({mutationFn:() => ozonMutate('settings',schedule),onSuccess:async () => {await invalidateOzon(); onClose();}});
  return <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]"><DialogHeader><DialogTitle>Настройки Ozon</DialogTitle><DialogDescription>Изменения применяются только к Ozon. Расписание Randewoo сохраняется отдельно.</DialogDescription></DialogHeader>
    <form className="grid gap-4" onSubmit={event => {event.preventDefault(); save.mutate();}}>
      <ScheduleFields value={schedule} onChange={setSchedule} prefix="ozon" disabled={save.isPending}/>
      {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
      <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</Button></div>
    </form>
  </DialogContent>;
}
