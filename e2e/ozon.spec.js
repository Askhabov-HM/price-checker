import {test,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Tracker} from '../src/service.js';
import {OzonService} from '../src/providers/ozon/service.js';
import {OzonClient} from '../src/providers/ozon/client.js';
import {makeServer,listen} from '../src/web.js';
import {connectTestOzon,ozonPage,jsonResponse,favoriteTile} from '../tests/ozon-fixture.js';

test('favorites show current and original prices and their history without reading product cards',async ({page},testInfo) => {
  const root=mkdtempSync(join(tmpdir(),'price-checker-ozon-ui-'));
  let server,tracker,ozon,price='950 ₽';const errors=[],reads=[];
  page.on('pageerror',error => errors.push(error.message));
  page.on('request',request => expect(new URL(request.url()).hostname).toBe('127.0.0.1'));
  try {
    tracker=new Tracker(root);await connectTestOzon(root);
    ozon=new OzonService(root,{client:new OzonClient(root,{browser:null,fetchImpl:async url => {
      const path=new URL(url).searchParams.get('url');reads.push(path);
      expect(path).toBe('/my/favorites?sorting=last_added');
      const data=ozonPage();delete data.location;delete data.widgetStates['addressBookBarWeb-1-default-1'];
      data.widgetStates['tileGridDesktop-8-default-1']=JSON.stringify({items:[favoriteTile('123',{price})]});
      return jsonResponse(data);
    }})});
    server=makeServer(tracker,{auth:null,ozon});const port=await listen(server,0),base='http://127.0.0.1:'+port;
    await page.goto(base+'/ozon');
    await expect(page.getByRole('heading',{name:'Ozon.'})).toBeVisible();
    await page.getByRole('button',{name:'Обновить избранное и цены'}).click();
    await expect(page.getByText('Тестовый товар 123',{exact:true})).toBeVisible();
    await expect(page.getByRole('columnheader',{name:'Цена Ozon',exact:true})).toBeVisible();
    await expect(page.getByRole('columnheader',{name:'Зачёркнутая цена',exact:true})).toBeVisible();
    await expect(page.locator('.ozon-table s')).toHaveText(/1\s500/);
    await expect(page.locator('#ozon-overview-chart .recharts-line-dot')).toHaveCount(1);
    await expect(page.locator('.ozon-sparkline .recharts-line-dot')).toHaveCount(1);
    await page.getByRole('button',{name:'История',exact:true}).click();
    await expect(page.locator('#ozon-detail-chart .recharts-line-dot')).toHaveCount(1);
    await expect(page.getByRole('dialog').getByText('Первая реальная проверка сохранена.',{exact:false})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('ozon-desktop.png'),fullPage:true});
    await page.keyboard.press('Escape');
    price='900 ₽';await page.getByRole('button',{name:'Обновить избранное и цены'}).click();
    await expect(page.locator('#ozon-overview-chart .recharts-line-dot')).toHaveCount(2);
    expect(reads).toEqual(['/my/favorites?sorting=last_added','/my/favorites?sorting=last_added']);
    await page.screenshot({path:testInfo.outputPath('ozon-overview-desktop.png'),fullPage:true});
    await page.getByRole('link',{name:'Randewoo',exact:true}).click();
    await expect(page.locator('#metric-count')).toHaveText('0');
    await page.getByRole('link',{name:'Ozon ↗'}).click();
    await expect(page.getByText('Тестовый товар 123',{exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:testInfo.outputPath('ozon-mobile.png'),fullPage:true});
    await page.goto(base+'/ozon/login');
    await expect(page.getByRole('heading',{name:'Вход в Ozon'})).toBeVisible();
    await expect(page.getByText('Окно входа пока недоступно на этом сервере.')).toBeVisible();
    expect(errors).toEqual([]);expect(ozon.status().schedule_enabled).toBe(false);
  } finally {
    server?.closeAllConnections();if(server)await new Promise(resolve => server.close(resolve));
    await ozon?.close();await tracker?.close();
    if(dirname(root)===resolve(tmpdir()) && basename(root).startsWith('price-checker-ozon-ui-'))rmSync(root,{recursive:true,force:true});
  }
});
