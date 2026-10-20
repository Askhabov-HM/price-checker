// Xvfb uses physical pixels; Chrome reports logical pixels after scaling.
// These defaults match a 2560x1440 desktop at 150% scaling.
export function ozonBrowserOptions(env = process.env) {
  const dimensions = (value, fallback) => {
    const text = value ?? fallback;
    if (!/^\d{3,4}x\d{3,4}$/.test(text)) throw Error('Invalid Ozon browser dimensions');
    const [width, height] = text.split('x').map(Number);
    if (width < 640 || width > 7680 || height < 480 || height > 4320) throw Error('Invalid Ozon browser dimensions');
    return {width, height};
  };
  const screen = dimensions(env.OZON_BROWSER_SCREEN, '3840x2160');
  const window = dimensions(env.OZON_BROWSER_WINDOW, '1282x1344');
  const scale = env.OZON_BROWSER_SCALE ?? '1.5';
  if (!['1', '1.25', '1.5', '1.75', '2'].includes(scale)) throw Error('Invalid Ozon browser scale');
  const graphics = env.OZON_BROWSER_GRAPHICS ?? 'auto';
  if (!['auto', 'swiftshader'].includes(graphics)) throw Error('Invalid Ozon browser graphics mode');
  return {
    screen: `${screen.width}x${screen.height}x24`,
    chromeArgs: [
      '--lang=ru', '--force-device-scale-factor='+scale,
      '--disable-blink-features=AutomationControlled',
      '--window-size='+window.width+','+window.height, '--window-position=0,0',
      ...(graphics === 'swiftshader' ? ['--use-gl=angle', '--use-angle=swiftshader'] : []),
    ],
  };
}
