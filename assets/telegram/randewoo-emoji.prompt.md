# Randewoo: подготовка эмодзи

Дата: 19.10.2026.
Режим: встроенный image_gen, редактирование приложенного владельцем логотипа.
Фон: прозрачный (alpha).

Файлы:

- `randewoo-logo-source.png` — выбранный результат image_gen, 1254 × 1254.
- `randewoo-emoji.png` — экспорт для Telegram, ровно 100 × 100, PNG RGBA.

После генерации выполнено только уменьшение до размера Telegram с сохранением alpha.
Владелец опубликовал эмодзи в наборе <https://t.me/addemoji/pcheck>.
Полученный через Telegram Bot API `custom_emoji_id`: `5382276449241703317`.
Соответствующий обычный эмодзи: `🌸`.

## Исходный промпт

```text
Use case: background-extraction. Asset type: static custom emoji for Telegram, based on the user's attached Randewoo logo. Input image 1 is the edit target, not a style suggestion. Remove only the solid white background and export a clean genuinely transparent PNG. Preserve the exact existing logo identity and layout: the gray capital Latin R in the lower-right, the curved pale turquoise stem and leaves in the lower-left, and the overlapping translucent lavender/lilac flower petals above. Preserve the reference's flat colors, overlaps, relative proportions, original letter shape and delicate simple geometry. Do not redesign or add any elements. Fit the complete mark into a square canvas with a small even safety margin so no petal or leaf is clipped. Make edges clean and crisp for legibility as a tiny Telegram emoji. Requested delivery size 100x100 pixels if supported, otherwise provide a high-resolution square PNG suitable for downscaling to exactly 100x100. Transparent alpha background everywhere outside the logo, including the counter of the R; no white tile, no backdrop, no checkerboard baked into pixels, no shadow, no border, no watermark, no extra text.
```

## Уточнение границ

```text
Use case: background-extraction. Edit the most recent generated Randewoo logo PNG. Single targeted change: clean the transparency mask and edges only. Keep the gray R, turquoise stem/leaf, overlapping lilac petals, their exact shape, colors and placement unchanged. Remove every stray white speck/white halo, bright magenta or blue noisy pixel, and all detached opaque fragments outside the intended logo silhouette. There must be genuinely transparent alpha outside the smooth, crisp logo contours and inside the R counter. This is a small static Telegram custom emoji, so clean simple antialiased outlines are essential. Preserve the square canvas and current complete logo composition. No background, no white tile, no checkerboard texture, no shadows or outlines, no added elements or text, no redesign.
```
