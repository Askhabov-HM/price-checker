import {useState, type FormEvent, type ReactNode} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {LockKeyhole} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {authOptions, login} from '@/lib/api';

export function AuthGate({children}: {children: ReactNode}) {
  const auth = useQuery(authOptions);
  if (auth.data?.authenticated) return children;
  return <main className="auth-screen"><section className="auth-card" aria-labelledby="login-title">
    <div className="auth-brand"><span className="brand-icon">p<span>·</span></span><span>pricechecker<small>ИСТОРИЯ ВАШИХ ЦЕН</small></span></div>
    <div className="auth-heading"><span className="auth-icon"><LockKeyhole size={19} /></span><h1 id="login-title">Вход в Price Checker</h1><p>Войдите, чтобы открыть коллекцию и историю цен.</p></div>
    {auth.isPending ? <p role="status" className="auth-message">Проверяем вход…</p> : auth.isError ? <div className="auth-message"><p role="alert">Не удалось подключиться к приложению.</p><Button variant="outline" onClick={() => {void auth.refetch();}}>Повторить</Button></div> : <LoginForm />}
    <p className="auth-footer">Ваша коллекция. История каждой цены.</p>
  </section></main>;
}

function LoginForm() {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const signIn = useMutation({mutationFn: () => login(username, password), onSettled: () => setPassword('')});
  const submit = (event: FormEvent) => {event.preventDefault(); signIn.mutate();};
  return <form id="login-form" className="auth-form" onSubmit={submit}>
    <div className="auth-field"><Label htmlFor="login-username">Логин</Label><Input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={80} autoFocus value={username} onChange={event => setUsername(event.target.value)} /></div>
    <div className="auth-field"><Label htmlFor="login-password">Пароль</Label><Input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} /></div>
    {signIn.error && <p role="alert" className="auth-error">{signIn.error.message}</p>}
    <Button id="login-submit" type="submit" disabled={signIn.isPending}>{signIn.isPending ? 'Входим…' : 'Войти'}</Button>
  </form>;
}
