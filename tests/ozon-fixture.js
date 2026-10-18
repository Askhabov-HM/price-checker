import {accountContext} from '../src/providers/ozon/account-context.js';
import {importOzonConnection} from '../src/providers/ozon/connection.js';

export const TEST_OZON_URL = 'https://www.ozon.ru/product/test-item-123/';
export function ozonPage({sku = '123',seller = '55',regular = '1 000 ₽',card = '900 ₽',account = 123} = {}) {
  return {userInfo:{user:{userId:account,isLoggedIn:true}},location:{current:{areaId:456,uid:'test-area',city:'Test city',countryCode:'RU'}},
    widgetStates:Object.fromEntries(Object.entries({
      'addressBookBarWeb-1-default-1':{customCell:{cells:[{text:{text:'Synthetic test address'}}]}},
      'webDetailSKU-2-default-1':{copyText:sku},'webProductHeading-3-default-1':{title:'Тестовый товар Ozon'},
      'webPrice-4-default-1':{isAvailable:true,price:regular,cardPrice:card,lexemes:{withOzonCard:'С банками'},link:'/modal/pdpListOfBanks?product_id='+sku},
      'webCurrentSeller-5-default-1':{header:{badge:{subscribed:{common:{action:{params:{sellerId:seller}}}}}},sellerCell:{centerBlock:{title:{text:'Продавец '+seller}}}},
      'cellList-6-default-1':{cells:[{dsCell:{centerBlock:{title:{text:'Ozon Банк'}}}}]},
      'searchResultsSort-7-default-1':{sortButton:{options:[{isSelected:true,action:{link:'/my/favorites?sorting=last_added'}}]}},
      'tileGridDesktop-8-default-1':{items:[]},'master-9-default-1':{summary:[]},
    }).map(([key,value]) => [key,JSON.stringify(value)])),nextPage:''};
}
export async function connectTestOzon(root, {cookies,current} = {}) {
  return importOzonConnection(root,{request:{method:'GET',url:'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=%2Fproduct%2F123%2F',headers:{'user-agent':'Synthetic test browser',accept:'application/json'}},
    reference:accountContext(ozonPage())},{cookies:cookies || [{name:'session',value:'synthetic-session',domain:'.ozon.ru',path:'/',secure:true,httpOnly:true,session:true}]},{current});
}
export const jsonResponse = value => new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
