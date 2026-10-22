// The invitation stays in the URL fragment: it is not sent to HTTP access logs.
export const androidLaunchPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lamoda · Android</title><body><h1>Lamoda на Android</h1><p><a id="open" href="intent://collect#Intent;scheme=pricechecker-lamoda;package=ru.pricechecker.lamoda;end">Открыть Lamoda Collector</a></p><p id="help">Приложение само откроет избранное и начнёт сбор. Оставьте его открытым до завершения.</p><p>Если Telegram блокирует переход, выберите в меню «Открыть в браузере» и нажмите кнопку ещё раз.</p><script src="/lamoda/android/launch.js"></script></body></html>`;

export const androidLaunchScript = `(() => {
  if (!location.hash) return;
  const match = /^#connect=([a-f0-9]{32})$/.exec(location.hash);
  const button = document.getElementById('open'), help = document.getElementById('help');
  if (!match) {
    button.removeAttribute('href');
    help.textContent = 'Ссылка подключения повреждена. Получите новую в личном боте: /lamoda_android.';
    return;
  }
  button.href = 'intent://collect?connect=' + match[1] + '#Intent;scheme=pricechecker-lamoda;package=ru.pricechecker.lamoda;end';
  button.textContent = 'Подключить телефон и открыть избранное';
  help.textContent = 'Нажмите кнопку в течение 10 минут. Телефон подключится к VPS автоматически. Ничего вводить не нужно. Не пересылайте эту ссылку.';
})();`;
