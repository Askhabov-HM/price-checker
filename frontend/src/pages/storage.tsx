import {useEffect,useState} from 'react';
import {useNavigate,useSearch} from '@tanstack/react-router';
import {useQuery,useMutation} from '@tanstack/react-query';
import {authOptions,logout,request} from '@/lib/api';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {columnNames,tableNames,displayValue,type StorageSearch,type Overview,type Records} from '@/lib/storage';
import './storage.css';

export function StoragePage(){
 const search=useSearch({from:'/storage'}),navigate=useNavigate({from:'/storage'});
 const auth=useQuery(authOptions),signOut=useMutation({mutationFn:logout});
 const tab=['overview','data','migrations','backups'].includes(search.tab||'')?search.tab!:'overview';
 const store=tab==='backups'?'journal':(['randewoo','ozon','lamoda'].includes(search.store||'')?search.store!:'randewoo');
 const overview=useQuery({queryKey:['storage','overview'],queryFn:({signal})=>request<Overview>('/api/storage/overview',{signal}),staleTime:30000});
 const table=tab==='migrations'?'migrations':tab==='backups'?(search.table==='runs'?'runs':'artifacts'):(search.table||'observations');
 const descriptor=overview.data?.catalogs[store]?.[table];
 const [revision,setRevision]=useState(0);
 const [detail,setDetail]=useState<Record<string,unknown>|null>(null),[query,setQuery]=useState(search.bq||''),[jump,setJump]=useState('1');
 const change=(patch:StorageSearch,reset=true)=>{setDetail(null);void navigate({search:previous=>({...previous,...(reset?{page:'1',anchor:undefined}:{}),...patch})});};
 const choose=(patch:StorageSearch)=>change({table:undefined,bsort:undefined,bq:undefined,from:undefined,to:undefined,status:undefined,availability:undefined,product_id:undefined,check_id:undefined,store_filter:undefined,...patch});
 useEffect(()=>setQuery(search.bq||''),[search.bq]);
 const params=new URLSearchParams({store,table,size:search.size||'100',page:search.page||'1'});
 for(const key of ['direction','anchor','from','to','status','availability','product_id','check_id','store_filter'] as const)if(search[key])params.set(key,search[key]!);
 if(search.bsort)params.set('sort',search.bsort);
 if(search.bq)params.set('q',search.bq);
 const records=useQuery({queryKey:['storage','rows',params.toString(),revision],queryFn:({signal})=>request<Records>('/api/storage/rows?'+params,{signal}),enabled:tab!=='overview'&&!!descriptor,staleTime:30000});
 const data=records.data;
 useEffect(()=>{if(!data)return;setJump(String(data.page));
  if((data.anchor!==null&&search.anchor===undefined)||Number(search.page||1)!==data.page)
   void navigate({replace:true,search:previous=>({...previous,page:String(data.page),anchor:data.anchor===null?undefined:String(data.anchor)})});
 },[data,navigate,search.anchor,search.page]);
 const refresh=()=>{if(tab==='overview')void overview.refetch();else {setRevision(value=>value+1);change({anchor:undefined},true);}};
 const links=(row:Record<string,unknown>)=>{
  if(tab!=='data')return null;
  if(table==='products'&&store==='randewoo')return <Button onClick={()=>choose({table:'variants',product_id:String(row.id)})}>Варианты товара</Button>;
  if(['products','variants','desktop_products'].includes(table))return <Button onClick={()=>choose({table:table==='desktop_products'?'desktop_observations':'observations',product_id:String(table==='variants'?row.id:row.sku??row.id)})}>История цен</Button>;
  if(['checks','desktop_snapshots'].includes(table))return <Button onClick={()=>choose({table:table==='checks'?'observations':'desktop_observations',check_id:String(row.id??row.run_id)})}>Наблюдения сбора</Button>;
  if(row.check_id!=null)return <Button onClick={()=>choose({table:'checks',check_id:String(row.check_id)})}>Открыть сбор</Button>;
  if(table==='desktop_observations')return <Button onClick={()=>choose({table:'desktop_snapshots',bq:String(row.run_id)})}>Открыть сбор</Button>;
  return null;
 };
 return <main className="storage-page">
  <header className="storage-heading"><div><a href="/">← К товарам</a><h1>Базы и резервные копии</h1><p>Просмотр записей · Время по Москве</p></div>{auth.data?.required&&<Button variant="ghost" onClick={()=>signOut.mutate()}>Выйти</Button>}</header>
  <nav className="storage-tabs" aria-label="Разделы хранилища">
   {Object.entries({overview:'Обзор',data:'Данные',migrations:'Миграции',backups:'Резервные копии'}).map(([key,label])=><Button key={key} variant={tab===key?'default':'outline'} aria-current={tab===key?'page':undefined} onClick={()=>choose({tab:key})}>{label}</Button>)}
   <Button variant="outline" onClick={refresh}>Обновить</Button>
  </nav>
  {(overview.error||signOut.error)&&<p role="alert">{(overview.error||signOut.error)?.message}</p>}
  {overview.isPending&&<p role="status">Загрузка…</p>}
  {tab==='overview'&&overview.data&&<>
   <div className="storage-cards">{overview.data.stores.map(item=><article key={item.store}>
    <h2>{item.store}</h2><p>{item.ok?'Хранилище доступно':'Хранилище недоступно'}</p>
    {item.ok&&<><p>Размер с WAL: {((item.bytes||0)/1024/1024).toFixed(1)} МБ · Формат {item.format}</p>{item.projections?.map(version=><p key={version.name}>{({price_rows:'Статистика',list_history:'Графики',collection_snapshot:'Сохранённый результат',desktop_rows:'Статистика Windows',desktop_history:'Графики Windows'} as Record<string,string>)[version.name]||version.name}: {version.version}</p>)}</>}
    <Button variant="outline" onClick={()=>choose({tab:'data',store:item.store})}>Открыть записи</Button>
   </article>)}</div>
   <h2>Последние известные копии</h2>
   {!overview.data.journal.ok?<p>Журнал резервирования ещё не установлен или недоступен.</p>:overview.data.journal.last.length===0?<p>Сведения о копиях ещё не получены.</p>:overview.data.journal.last.map(item=><p key={item.store}>{item.store}: {displayValue('created_at',item.created_at)} · наличие проверено {displayValue('checked_at',item.checked_at)}</p>)}
  </>}
  {tab!=='overview'&&<>
   <div className="storage-filters">
    {tab!=='backups'&&<label>Магазин<select aria-label="Магазин" value={store} onChange={e=>choose({store:e.target.value})}>{['randewoo','ozon','lamoda'].map(value=><option key={value}>{value}</option>)}</select></label>}
    {tab!=='migrations'&&<label>Таблица<select aria-label="Таблица" value={table} onChange={e=>choose({table:e.target.value})}>{Object.keys(overview.data?.catalogs[store]||{}).filter(key=>tab==='backups'||key!=='migrations').map(key=><option key={key} value={key}>{tableNames[key]||key}</option>)}</select></label>}
    {!!descriptor?.search.length&&<form onSubmit={e=>{e.preventDefault();change({bq:query||undefined});}}><label>Поиск<input aria-label="Поиск записей" value={query} maxLength={150} onChange={e=>setQuery(e.target.value)} placeholder="ID, артикул, название"/></label><Button type="submit" variant="outline">Найти</Button></form>}
    {descriptor?.date&&(['from','to'] as const).map(key=><label key={key}>{key==='from'?'С даты':'По дату'}<input aria-label={key==='from'?'С даты':'По дату'} type="date" value={search[key]||''} onChange={e=>change({[key]:e.target.value||undefined})}/></label>)}
    {Object.keys(descriptor?.filters||{}).map(key=><Filter store={store} table={table} key={store+table+key+(search[key as keyof StorageSearch]||'')} name={key} value={search[key as keyof StorageSearch]||''} onApply={value=>change({[key]:value||undefined})}/>)}
    <Button variant="ghost" onClick={()=>choose({table})}>Сбросить фильтры</Button>
   </div>
   <div className="storage-tools"><label>Строк на странице<select value={search.size||'100'} onChange={e=>change({size:e.target.value})}>{[50,100,200].map(size=><option key={size}>{size}</option>)}</select></label>
    {data&&<><a title="Исходные значения: цены в копейках, даты как в базе" href={'/api/storage/export?'+params+'&scope=page'}>CSV: страница</a><a title="Исходные значения: цены в копейках, даты как в базе" href={'/api/storage/export?'+params+'&scope=all'}>CSV: весь результат</a></>}
   </div>
   {records.isFetching&&<p role="status">Загрузка записей…</p>}{records.error&&<p role="alert">{records.error.message}</p>}
   {overview.data&&!descriptor&&<p role="alert">Выберите доступную таблицу.</p>}
   {data&&<>
    <div className="storage-grid"><table><thead><tr>{data.columns.map(column=><th key={column} aria-sort={search.bsort===column?(search.direction==='asc'?'ascending':'descending'):'none'}><button onClick={()=>change({bsort:column,direction:search.bsort===column&&search.direction==='asc'?'desc':'asc'})}>{columnNames[column]||column}{search.bsort===column?(search.direction==='asc'?' ↑':' ↓'):''}</button></th>)}</tr></thead>
    <tbody>{data.rows.map((row,index)=><tr key={index} className={row.status==='error'?'storage-error':['unavailable','out_of_stock'].includes(String(row.availability))||row.in_stock===0?'storage-unavailable':''}>{data.columns.map((column,i)=><td key={column} title={displayValue(column,row[column])}>{i===0?<button className="storage-record" aria-label={'Открыть запись '+String(row[column])} onClick={()=>setDetail(row)}>{displayValue(column,row[column])}</button>:displayValue(column,row[column])}</td>)}</tr>)}</tbody></table></div>
    {!data.rows.length&&<p>Записи не найдены.</p>}
    <div className="storage-pagination"><span>Найдено {data.total.toLocaleString('ru-RU')} · Страница {data.page} из {data.pages}</span>
     <Button variant="outline" disabled={data.page===1||records.isFetching} onClick={()=>change({page:String(data.page-1)},false)}>Назад</Button>
     <Button variant="outline" disabled={data.page===data.pages||records.isFetching} onClick={()=>change({page:String(data.page+1)},false)}>Далее</Button>
     <form onSubmit={e=>{e.preventDefault();const value=Number(jump);if(Number.isInteger(value)&&value>=1&&value<=data.pages)change({page:String(value)},false);}}><input aria-label="Номер страницы" type="number" min={1} max={data.pages} value={jump} onChange={e=>setJump(e.target.value)}/><Button variant="outline" type="submit">Перейти</Button></form>
    </div>
   </>}
  </>}
  <Dialog open={detail!==null} onOpenChange={open=>{if(!open)setDetail(null);}}><DialogContent className="storage-detail"><DialogTitle>Запись: {tableNames[table]}</DialogTitle><DialogDescription>Только просмотр. Время по Москве.</DialogDescription>{detail&&<><dl>{Object.entries(detail).map(([column,value])=><div key={column}><dt>{columnNames[column]||column} <small>({column})</small></dt><dd>{displayValue(column,value)}</dd></div>)}</dl>{links(detail)}</>}</DialogContent></Dialog>
 </main>;
}
function Filter({name,value,onApply,store,table}:{name:string;value:string;onApply:(value:string)=>void;store:string;table:string}){
 const [input,setInput]=useState(value);
 const labels:Record<string,string>={status:'Результат',availability:'Наличие',product_id:'ID товара / варианта',check_id:'ID сбора / операции',store_filter:'Магазин'};
 let options:string[]|null=null;
 if(name==='store_filter')options=['randewoo','ozon','lamoda','journal'];
 if(name==='availability')options=store==='journal'?['present','absent','unknown']:store==='randewoo'?['1','0']:['available','unavailable','out_of_stock','unknown'];
 if(name==='status')options=table==='artifacts'?['unknown','sqlite_ok','restore_ok']:table==='runs'?['running','success','error','interrupted','skipped']:['ok','success','error','running','interrupted','missing','partial','canceled'];
 if(options)return <label>{labels[name]}<select aria-label={labels[name]} value={value} onChange={e=>onApply(e.target.value)}><option value="">Все</option>{options.map(option=><option key={option} value={option}>{option==='1'?'В наличии':option==='0'?'Нет в наличии':displayValue(name==='status'&&table==='artifacts'?'verification':name,option)}</option>)}</select></label>;
 return <form onSubmit={e=>{e.preventDefault();onApply(input);}}><label>{labels[name]||name}<input aria-label={labels[name]||name} value={input} maxLength={150} onChange={e=>setInput(e.target.value)}/></label><Button type="submit" variant="outline">Применить</Button></form>;
}
