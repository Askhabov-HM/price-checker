export interface CaptchaConfig {script_url: string; api_endpoint: string;}
interface CapInstance {solve: () => Promise<{token: string}>; widget: HTMLElement;}
declare global {interface Window {Cap?: new (options: {apiEndpoint: string}) => CapInstance;}}
let scriptPromise: Promise<void> | undefined;

export async function solveCaptcha(config: CaptchaConfig | null) {
  if (!config) return '';
  if (config.script_url !== 'https://captcha.randewoo.ru/assets/widget.js'
    || !/^https:\/\/captcha\.randewoo\.ru\/[\w-]+\/$/.test(config.api_endpoint)) throw new Error('Изменился способ входа Randewoo');
  if (!window.Cap) {
    scriptPromise ||= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => {script.remove(); scriptPromise = undefined; reject(new Error('Не удалось загрузить проверку Randewoo'));}, 15000);
      script.src = config.script_url;
      script.onload = () => {clearTimeout(timer); resolve();};
      script.onerror = () => {clearTimeout(timer); script.remove(); scriptPromise = undefined; reject(new Error('Не удалось загрузить проверку Randewoo'));};
      document.head.appendChild(script);
    });
    await scriptPromise;
  }
  if (!window.Cap) throw new Error('Проверка Randewoo недоступна');
  const cap = new window.Cap({apiEndpoint: config.api_endpoint});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([cap.solve(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Проверка Randewoo заняла слишком много времени. Повторите подключение')), 60000);
    })]);
    if (!result.token) throw new Error('Не удалось пройти проверку Randewoo');
    return result.token;
  } finally {clearTimeout(timer); cap.widget.remove();}
}
