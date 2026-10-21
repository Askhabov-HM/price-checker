import {Link,Outlet,useSearch} from '@tanstack/react-router';
import {useMutation,useQuery} from '@tanstack/react-query';
import {ShoppingBag,LogOut,KeyRound} from 'lucide-react';
import {authOptions,logout} from '@/lib/api';
import {Button} from './ui/button';

export function LamodaShell() {
  const search = useSearch({from:'__root__'}),auth = useQuery(authOptions),signOut = useMutation({mutationFn:logout});
  return <><aside className="sidebar"><Link className="brand" to="/lamoda" search={search}><span className="brand-icon">p<span>·</span></span><span>pricechecker<small>ИСТОРИЯ ВАШИХ ЦЕН</small></span></Link>
    <div className="sidebar-label">МАГАЗИНЫ</div><nav aria-label="Магазины">
      <Link className="nav-link" to="/$listId" params={{listId:'cart'}} search={search}><ShoppingBag size={19}/><span>Randewoo</span></Link>
      <Link className="nav-link" to="/ozon" search={{...search,ozonList:'favorites',price:'listed'}}><ShoppingBag size={19}/><span>Ozon</span></Link>
      <Link className="nav-link active" to="/lamoda" search={search}><ShoppingBag size={19}/><span>Lamoda</span></Link>
    </nav><div className="sidebar-note"><strong>Всё избранное</strong><p>Цены товаров и цветов без выбора размеров.</p></div>
    <div className="sidebar-bottom"><Link className="nav-link" to="/lamoda/login" search={search}><KeyRound size={19}/><span>Вход в Lamoda</span></Link></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumb">Моя коллекция <span>/</span> <b>Lamoda</b></div>
      {auth.data?.required && <Button variant="ghost" size="sm" disabled={signOut.isPending} onClick={() => signOut.mutate()}><LogOut size={16}/>Выйти</Button>}</header>
      <div className="workspace">{signOut.error && <p className="notice" role="alert">{signOut.error.message}</p>}<Outlet/><footer className="page-footer"><span>pricechecker · Lamoda</span><span>Цены из вашего избранного</span></footer></div>
    </main></>;
}
