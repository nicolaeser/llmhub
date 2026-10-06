# next-intl-icu.md

Load this document with the localization Instruction whenever changing `lang/`, user-visible strings, counts, dates, money, lists, or locale-sensitive formatting.

Canonical API: [next-intl translations](https://next-intl.dev/docs/usage/translations). Also: [numbers](https://next-intl.dev/docs/usage/numbers), [dates and times](https://next-intl.dev/docs/usage/dates-times), [lists](https://next-intl.dev/docs/usage/lists), [display names](https://next-intl.dev/docs/usage/display-names), [configuration](https://next-intl.dev/docs/usage/configuration).

## Rule

Language state belongs in messages. Application state belongs in code.

Must express plurals, ordinals, enum labels, interpolation, and locale-sensitive number/date/list formatting with ICU or `useFormatter`/`getFormatter`. Must not choose words with `if`/`switch`, and must not call `toLocaleString` or construct `Intl.*` formatters in UI or request-scoped rendering.

Keep `if` only for control flow: empty vs populated UI, auth gates, business rules, rendering different components.

## ICU messages

### Static

```json
"message": "Hello world!"
```

`t('message')` → `"Hello world!"`

### Interpolation

```json
"message": "Hello {name}!"
```

`t('message', {name: 'Jane'})` → `"Hello Jane!"`

Value names must be alphanumeric or underscore. Dashes are invalid.

### Cardinal pluralization

```json
"message": "You have {count, plural, =0 {no followers yet} =1 {one follower} other {# followers}}."
```

`t('message', {count: 3580})` → `"You have 3,580 followers."`

`#` formats the number for the locale. `other` is required. Use `=0` when zero copy is distinct from `other`.

Plural tags depend on the language (`zero`, `one`, `two`, `few`, `many`, `other`). English typically needs `one` and `other`; German is the same. Do not invent JS branches for those forms.

### Ordinal pluralization

```json
"message": "It's your {year, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} birthday!"
```

### Selecting enum-based values

```json
"message": "{gender, select, female {She is} male {He is} other {They are}} online."
```

`other` is required. Select values must be alphanumeric or underscore. Map `en-GB` → `en_GB` before passing it in.

Use `select` for status, role, plan, method, and similar finite identifiers instead of `switch` that returns a label.

### Escaping

Literal curly braces: wrap in single quotes (`'{name}'`).

### Rich text

```json
"message": "Please refer to <guidelines>the guidelines</guidelines>."
```

```tsx
t.rich('message', {
  guidelines: (chunks) => <a href="/guidelines">{chunks}</a>
});
```

Tags may nest. Self-closing still needs a close tag: `<br></br>` mapped to `() => <br />`. Attributes are set at the call site, not inside the message. Shared tags may live in a small `RichText` helper.

### HTML markup

`t.markup` returns a string. Use only when the consumer needs HTML text, not React nodes.

### Raw messages

`t.raw` skips ICU parsing. The value may be any JSON type. Must sanitize before `dangerouslySetInnerHTML`. Must not use `t.raw` for a list of translatable sentences; map explicit keys in the component so ICU and static validation still work.

### Optional messages

`t.has('title')` checks whether a key exists for the current locale. Default-locale fallback is configuration, not permission to skip a key that both locales should have.

### Arrays of messages

Map known keys in the component:

```tsx
const items = [
  { title: t('yearsOfService.title'), value: t('yearsOfService.value') },
  { title: t('happyClients.title'), value: t('happyClients.value') }
];
```

If the set of keys truly varies by locale, read keys from `useMessages()` / `getMessages()` and still call `t()` per key.

## Numbers

Must use `useFormatter().number` or `getFormatter().number`, or embed `{value, number}` in a message.

```tsx
const format = useFormatter();
format.number(499.9, {style: 'currency', currency: 'USD'});
format.number(499.9, 'precise'); // global format name
```

In messages:

```json
{
  "basic": "Basic formatting: {value, number}",
  "percentage": "Displayed as a percentage: {value, number, percent}",
  "custom": "At most 2 fraction digits: {value, number, ::.##}",
  "price": "This product costs {price, number, currency}"
}
```

`::` introduces a number skeleton. Built-in names: `currency`, `percent`. Named formats come from `src/i18n/formats.ts`.

## Dates and times

Must use `format.dateTime`, `format.relativeTime`, `format.dateTimeRange`, or ICU `{orderDate, date, medium}`.

```tsx
const format = useFormatter();
const now = useNow(); // or getNow() on the server
format.dateTime(date, {year: 'numeric', month: 'short', day: 'numeric'});
format.dateTime(date, 'short');
format.relativeTime(date, now);
format.relativeTime(date, {now, unit: 'day'});
format.dateTimeRange(start, end, 'short');
```

Prefer `useNow` / `getNow` over `new Date()` in render. Use `updateInterval` only when a relative string must tick.

In messages: `{orderDate, date, medium}` or `{orderDate, date, ::yyyyMMMd}`. Built-in date styles: `full`, `long`, `medium`, `short`.

## Lists

There is no ICU list syntax. Must use `format.list(items, {type: 'conjunction'})` or a named global list format. May pass React elements.

## Display names

```tsx
format.displayName('US', {type: 'region'});
format.displayName('en', {type: 'language'});
format.displayName('USD', {type: 'currency'});
```

`type` is required.

## Global formats

Define reusable formats in `src/i18n/formats.ts` and return them from `getRequestConfig`. Client trees inherit them through `NextIntlClientProvider` rendered by a Server Component.

Typical names: `dateTime.short|long|full|time|dateTime`, `number.decimal|integer|percent|compact|currency`, `list.enumeration|alternatives`.

## Call sites

Client / shared components:

```tsx
const t = useTranslations('Namespace');
const format = useFormatter();
t('followers', {count});
format.number(amount, 'currency');
```

Async Server Components, actions, route handlers:

```ts
const t = await getTranslations('Namespace');
const format = await getFormatter();
```

Helpers outside a request must receive already-formatted strings or a formatter bound to the request locale. Must not hardcode `en-US` / `de-DE` inside shared libs that render user-facing values.

## Prohibited in user-facing copy

- `count === 1 ? t('one') : t('other')` or string concatenation of `"s"`
- `switch (status)` / `if (status === 'active')` that only returns a label — use `select`
- `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`
- `new Intl.NumberFormat` / `DateTimeFormat` / `ListFormat` / `RelativeTimeFormat` / `DisplayNames` in UI
- Building a sentence by concatenating `t()` fragments
- `t.raw()` arrays of copy when keys can be enumerated
- Shipping a key or ICU branch in only one locale

## Locale parity

ICU argument names, plural/select branches, and rich tags must match across `lang/en` and `lang/de`. German may use different wording inside a branch. It must not drop `other` or rename `{count}`.

## Error handling

Missing or invalid messages should stay visible via `onError` / `getMessageFallback` in `src/i18n/request.ts`. Do not swallow translation errors in new code. Those options are not inherited by Client Components unless a client provider sets them.

## Sources of truth

- `src/i18n/routing.ts` — locales, default locale, prefix
- `src/i18n/request.ts` — messages, formats, `now`, `timeZone`
- `src/i18n/formats.ts` — named number/date/list formats
- `src/i18n/messages.ts` — namespace loading
- `lang/<locale>/` — message catalogs
