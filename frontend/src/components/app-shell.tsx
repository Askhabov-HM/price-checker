import {useEffect, useState} from 'react';
import {Link, Outlet, useParams, useSearch} from '@tanstack/react-router';
import {useQuery} from '@tanstack/react-query';
import {ShoppingBag, ShoppingBasket, Heart, Eye, Plus, Settings} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {dashboardOptions, queryClient, statusOptions} from '@/lib/api';
import {labels, listIds} from '@/lib/format';
import type {ListId} from '@/lib/types';
import {AddDialog, SettingsDialog} from './forms';

export function AppShell() {
  const params = useParams({strict: false}), search = useSearch({from: '__root__'});
  const list = (params.listId || 'cart') as ListId;
  const {data: status, error} = useQuery(statusOptions);
  const dashboard = useQuery(dashboardOptions(list, list === 'my-cart' ? 'public' : search.context));
  const [adding, setAdding] = useState(false), [settings, setSettings] = useState(false);
  const check = status?.checks[0], version = check ? `${check.id}:${check.completed}:${check.status}` : 'empty';
  useEffect(() => {
    void queryClient.invalidateQueries({queryKey: ['dashboard']});
    void queryClient.invalidateQueries({queryKey: ['detail']});
  }, [version]);
  const testMode = status?.test_mode || document.querySelector('meta[name="price-checker-test-mode"]')?.getAttribute('content') === 'true';
  const icons = {cart: ShoppingBag, 'my-cart': ShoppingBasket, favorites: Heart, watching: Eye};
  return <><aside className="sidebar"><Link className="brand" to="/$listId" params={{listId: 'cart'}} search={search}><span className="brand-icon">p<span>·</span></span><span>pricechecker<small>ИСТОРИЯ ВАШИХ ЦЕН</small></span></Link><div className="sidebar-label">МОЯ КОЛЛЕКЦИЯ</div>
    <nav id="navigation" aria-label="Списки товаров">{listIds.map(id => {const Icon = icons[id]; return <Link key={id} to="/$listId" params={{listId: id}} search={id === 'my-cart' ? {...search, context: 'public'} : search} data-list={id} aria-label={labels[id]} className={`nav-link ${list === id ? 'active' : ''}`} aria-current={list === id ? 'page' : undefined}><Icon size={19} /><span>{labels[id]}</span><span className="count" id={`count-${id}`}>{dashboard.data?.counts[id] ?? 0}</span></Link>;})}</nav>
    <Button id="add-side" variant="ghost" className="add-side max-[850px]:size-10 max-[850px]:p-0" aria-label="Добавить товар" onClick={() => setAdding(true)}>
      <Plus size={14} /><span className="sidebar-action-label">Добавить товар</span>
    </Button>
    <div className="sidebar-note"><strong>Только пробники 1,5 мл</strong><p>Сохраняем реальные проверки и показываем, как меняется цена.</p></div>
    <div className="sidebar-bottom">
      <Button id="settings-button" variant="ghost" className="settings-button max-[850px]:size-10 max-[850px]:p-0" aria-label="Настройки" disabled={!status} onClick={() => setSettings(true)}>
        <Settings size={16} /><span className="sidebar-action-label">Настройки</span>
      </Button>
      <div className="local-status"><span className="dot" /><div>Работает локально<small id="auth-label">{status?.auth_status === 'ok' ? 'Randewoo подключён' : status?.auth_status === 'expired' ? 'Нужно обновить сессию' : status?.auth_status === 'error' ? 'Ошибка соединения' : 'Сессия не проверена'}</small></div></div>
    </div>
  </aside><main className="main"><header className="topbar"><div className="breadcrumb">Моя коллекция <span>/</span> <b>{labels[list]}</b></div><div className="topbar-right"><span className="local-pill"><span className="dot" /> Локальная история цен</span><span className="avatar">PC</span></div></header><div className="workspace">
    {testMode && <div className="notice" id="test-mode-banner">ТЕСТОВЫЙ РЕЖИМ · Управляемые цены аромата Test Lab / Graph Eau</div>}
    {error && <div role="alert" className="notice">Приложение недоступно. Проверьте, что оно запущено на компьютере.</div>}
    <Outlet />
    <footer className="page-footer"><span>pricechecker · Ваша история начинается с первой проверки</span><span>Проверки работают, пока приложение запущено и компьютер не спит</span></footer>
  </div></main><AddDialog open={adding} destination={list === 'my-cart' ? 'my-cart' : 'watching'} onClose={() => setAdding(false)} /><SettingsDialog status={status} open={settings} onClose={() => setSettings(false)} /></>;
}
