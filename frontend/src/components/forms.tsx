import {useState, type FormEvent} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {invalidatePrices, mutate} from '@/lib/api';
import type {Status} from '@/lib/types';

export function AddDialog({open, onClose}: {open: boolean; onClose: () => void}) {
  return <Dialog open={open} onOpenChange={value => {if (!value) onClose();}}>{open && <AddForm onClose={onClose} />}</Dialog>;
}
function AddForm({onClose}: {onClose: () => void}) {
  const [url, setUrl] = useState('');
  const add = useMutation({mutationFn: () => mutate('/api/watch/add', {url}), onSuccess: async () => {await invalidatePrices(); onClose();}});
  return <DialogContent className="sm:max-w-[560px]"><DialogHeader><DialogTitle>Добавить в наблюдение</DialogTitle><DialogDescription>Найдём вариант 1,5 мл и сохраним его текущую цену.</DialogDescription></DialogHeader><form id="add-form" onSubmit={event => {event.preventDefault(); add.mutate();}} className="grid gap-4"><Label htmlFor="add-url">Ссылка на товар Randewoo</Label><Input id="add-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://randewoo.ru/product/…" />{add.error && <p role="alert">{add.error.message}</p>}<div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button id="add-submit" type="submit" disabled={add.isPending}>{add.isPending ? 'Получаем цену…' : 'Добавить товар'}</Button></div></form></DialogContent>;
}
export function SettingsDialog({status, open, onClose}: {status?: Status; open: boolean; onClose: () => void}) {
  return <Dialog open={open} onOpenChange={value => {if (!value) onClose();}}>{open && status && <SettingsForm status={status} onClose={onClose} />}</Dialog>;
}
function SettingsForm({status, onClose}: {status: Status; onClose: () => void}) {
  const [schedule, setSchedule] = useState(status.schedule.join(', ')), [enabled, setEnabled] = useState(status.schedule_enabled);
  // Session fields are transient and are destroyed when the dialog closes.
  const [cookie, setCookie] = useState(''), [agent, setAgent] = useState(navigator.userAgent);
  const save = useMutation({
    mutationFn: async () => {
      await mutate('/api/settings', {schedule: schedule.split(/[,;\s]+/).map(value => value.trim()).filter(Boolean), schedule_enabled: enabled});
      if (cookie.trim()) await mutate('/api/session', {cookie, user_agent: agent});
    },
    onSuccess: async () => {setCookie(''); await invalidatePrices(); onClose();},
  });
  const submit = (event: FormEvent) => {event.preventDefault(); save.mutate();};
  return <DialogContent id="settings-dialog" className="max-h-[90vh] overflow-y-auto sm:max-w-[540px]"><DialogHeader><DialogTitle>Настройки</DialogTitle><DialogDescription>Расписание проверок и подключение Randewoo</DialogDescription></DialogHeader><form id="settings-form" onSubmit={submit} className="grid gap-4">
    <Label htmlFor="schedule-input">Время проверок по Москве</Label><Input id="schedule-input" required value={schedule} onChange={event => setSchedule(event.target.value)} placeholder="00:30, 09:00, 14:00, 20:00" /><p className="text-xs text-muted-foreground">В формате ЧЧ:ММ, через запятую. После сна выполняется одна проверка за последний пропущенный интервал.</p>
    <Label className="flex items-center gap-2"><input id="schedule-enabled" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Проверять автоматически, пока приложение работает</Label>
    <h3 className="border-t pt-4">Сессия Randewoo</h3><p className="text-xs text-muted-foreground">{status.auth_message || 'Данные сессии ещё не проверены'}</p>
    <details><summary className="cursor-pointer text-sm text-primary">Обновить данные авторизации</summary><div className="mt-4 grid gap-3"><p className="text-xs text-muted-foreground">Заголовки Cookie и User-Agent из своего запроса /cart в DevTools. Значения сохраняются только локально.</p><Label htmlFor="session-cookie">Cookie</Label><Input id="session-cookie" type="password" autoComplete="off" spellCheck={false} value={cookie} onChange={event => setCookie(event.target.value)} /><Label htmlFor="session-agent">User-Agent</Label><Input id="session-agent" value={agent} onChange={event => setAgent(event.target.value)} /></div></details>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</Button></div>
  </form></DialogContent>;
}
