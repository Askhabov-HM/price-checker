import {useEffect, useRef, useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {invalidatePrices, mutate} from '@/lib/api';
import {solveCaptcha, type CaptchaConfig} from '@/lib/randewoo-captcha';

interface Challenge {challenge_id: string; captcha: CaptchaConfig | null;}

export function RandewooConnection({message}: {message: string}) {
  const [phone, setPhone] = useState(''), [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [sent, setSent] = useState(false), [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [resendAt, setResendAt] = useState(0), [clock, setClock] = useState(Date.now());
  const mounted = useRef(true), active = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {mounted.current = false; generation.current++; clearInterval(timer); if (active.current) void mutate('/api/randewoo/cancel', {challenge_id: active.current}).catch(() => {});};
  }, []);
  const remaining = Math.max(0, Math.ceil((resendAt - clock) / 1000));

  async function sendCode() {
    setError(''); setBusy('Проверяем подключение…');
    const current = generation.current;
    const alive = () => mounted.current && generation.current === current;
    try {
      const prepared = challenge || await mutate<Challenge>('/api/randewoo/prepare', {});
      if (!alive()) {void mutate('/api/randewoo/cancel', {challenge_id: prepared.challenge_id}).catch(() => {}); return;}
      active.current = prepared.challenge_id;
      setChallenge(prepared); setBusy('Проходим проверку Randewoo…');
      const token = await solveCaptcha(prepared.captcha);
      if (!alive()) return;
      setBusy('Запрашиваем код…');
      const response = await mutate<{sent: boolean; resend_after: number}>('/api/randewoo/send-code', {challenge_id: prepared.challenge_id, phone, cap_token: token});
      if (!alive()) return;
      setSent(true); setCode(''); setResendAt(Date.now() + response.resend_after * 1000); setClock(Date.now());
    } catch (failure) {if (alive()) setError(failure instanceof Error ? failure.message : 'Не удалось запросить код');}
    finally {if (alive()) setBusy('');}
  }

  async function confirmCode() {
    setError(''); setBusy('Подключаем Randewoo…');
    try {
      await mutate('/api/randewoo/confirm', {challenge_id: challenge?.challenge_id, code});
      if (!mounted.current) return;
      active.current = null; setPhone(''); setCode(''); setChallenge(null); setSent(false); setConnected(true);
      await invalidatePrices();
    } catch (failure) {if (mounted.current) setError(failure instanceof Error ? failure.message : 'Не удалось подключить Randewoo');}
    finally {if (mounted.current) setBusy('');}
  }

  async function reset() {
    generation.current++;
    setBusy(''); setError(''); setCode(''); setSent(false); setChallenge(null); setConnected(false);
    if (active.current) {const id = active.current; active.current = null; await mutate('/api/randewoo/cancel', {challenge_id: id}).catch(() => {});}
  }

  return <section aria-label="Подключение Randewoo" className="grid gap-3">
    <h3 className="border-t pt-4">Подключение Randewoo</h3>
    <p className="text-xs text-muted-foreground">{connected ? 'Randewoo подключён. Запустите проверку цен для обновления корзины и избранного.' : message || 'Подключите аккаунт для синхронизации корзины и избранного.'}</p>
    {!connected && <>
      <Label htmlFor="randewoo-phone">Телефон Randewoo</Label>
      <Input id="randewoo-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+7 (999) 123-45-67" value={phone} disabled={sent || Boolean(busy)} maxLength={25} onChange={event => setPhone(event.target.value)} />
      <p className="text-xs text-muted-foreground">Введите российский мобильный номер аккаунта. Код придёт способом, выбранным Randewoo. Действующая сессия сохранится до успешного входа.</p>
      {sent && <><Label htmlFor="randewoo-code">Код Randewoo</Label><Input id="randewoo-code" inputMode="numeric" autoComplete="one-time-code" type="text" value={code} disabled={Boolean(busy)} maxLength={8} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} onKeyDown={event => {if (event.key === 'Enter' && /^\d{4,8}$/.test(code) && !busy) {event.preventDefault(); void confirmCode();}}} /></>}
      <div className="flex flex-wrap gap-2">
        {sent && <Button type="button" disabled={Boolean(busy) || !/^\d{4,8}$/.test(code)} onClick={() => void confirmCode()}>Подтвердить код</Button>}
        <Button type="button" variant={sent ? 'outline' : 'default'} disabled={Boolean(busy) || !phone.trim() || remaining > 0} onClick={() => void sendCode()}>{sent ? remaining > 0 ? `Повторить через ${remaining} с` : 'Отправить код повторно' : 'Получить код Randewoo'}</Button>
        {challenge && <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => void reset()}>Начать заново</Button>}
      </div>
    </>}
    {connected && <Button type="button" variant="outline" onClick={() => void reset()}>Подключить другой аккаунт</Button>}
    {busy && <p role="status" className="text-sm">{busy}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
