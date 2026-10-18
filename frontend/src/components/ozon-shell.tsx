import {Link, Outlet, useSearch} from '@tanstack/react-router';
import {useMutation, useQuery} from '@tanstack/react-query';
import {ArrowLeft, LogOut, ShoppingBag} from 'lucide-react';
import {authOptions, logout} from '@/lib/api';
import {Button} from './ui/button';

export function OzonShell() {
  const search = useSearch({from:'__root__'}), auth = useQuery(authOptions);
  const signOut = useMutation({mutationFn:logout});
  return <><aside className="sidebar"><Link className="brand" to="/ozon" search={{...search,ozonList:'watching',price:'ozon_card'}}><span className="brand-icon">p<span>·</span></span><span>pricechecker<small>ИСТОРИЯ ВАШИХ ЦЕН</small></span></Link>
    <div className="sidebar-label">МАГАЗИНЫ</div><nav aria-label="Магазины"><Link className="nav-link" to="/$listId" params={{listId:'cart'}} search={search}><ArrowLeft size={19}/><span>Randewoo</span></Link><Link className="nav-link active" aria-current="page" to="/ozon" search={{...search,ozonList:'watching',price:'ozon_card'}}><ShoppingBag size={19}/><span>Ozon</span></Link></nav>
    <div className="sidebar-note"><strong>Любые категории</strong><p>Обычная цена и цена Ozon Карты. История каждого товара и продавца.</p></div></aside>
    <main className="main"><header className="topbar"><div className="breadcrumb">Моя коллекция <span>/</span> <b>Ozon</b></div><div className="topbar-right">{auth.data?.required && <Button variant="ghost" size="sm" aria-label="Выйти из Price Checker" disabled={signOut.isPending} onClick={() => signOut.mutate()}><LogOut size={16}/>Выйти</Button>}</div></header>
      <div className="workspace">{signOut.error && <p className="notice" role="alert">{signOut.error.message}</p>}<Outlet/><footer className="page-footer"><span>pricechecker · Ozon</span><span>Условия оплаты и доставки влияют на цену</span></footer></div></main></>;
}
