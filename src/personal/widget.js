import { dateTitle, escapeHtml } from "../schedule/format.js";
import { scheduleViewTimeline } from "../schedule/view-timeline.js";
import { t } from "./view.js";

const pageSize = 4;
const short = (value, max) => {
  const chars = Array.from(String(value ?? "").replaceAll("\0", ""));
  return escapeHtml(chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join(""));
};

const style = `<style>
html{color-scheme:light dark}
body{--ink:var(--tg-theme-text-color,light-dark(#19263a,#e5edf7));--muted:var(--tg-theme-subtitle-text-color,light-dark(#52647c,#a8b9d0));--surface:var(--tg-theme-secondary-bg-color,light-dark(#edf3fa,#1c293b));--line:var(--tg-theme-section-separator-color,light-dark(#d8e3f0,#34455c));--accent:var(--tg-theme-accent-text-color,light-dark(#2457aa,#92bdff));margin:0;padding:16px 14px 14px;color:var(--ink);font:var(--tg-text-font-size,15px)/1.35 system-ui,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}
h1,p{margin:0}h1{font-size:1.3em;letter-spacing:-.025em;font-weight:700}small,.muted,time{color:var(--muted);font-size:.78em}
.tag,.num{background:var(--surface);color:var(--accent);border-radius:9px;padding:4px 8px;font-size:.8em;font-weight:700}
.live{background:var(--surface);padding:9px 11px;border-radius:12px;margin-bottom:8px}
.live p{display:flex;justify-content:space-between;gap:8px;font-size:.8em;font-weight:650;color:var(--accent)}
.track{height:5px;margin-top:6px;border-radius:5px;background:var(--line);overflow:hidden}
#fill{height:100%;width:0;border-radius:5px;background:linear-gradient(100deg,var(--accent),var(--tg-theme-link-color,var(--accent)));transition:width .6s ease}
details{border-bottom:1px solid var(--line)}details:last-child{border-bottom:0}
summary{display:flex;align-items:center;gap:9px;list-style:none;cursor:pointer;padding:8px 0;min-height:27px}
summary::-webkit-details-marker{display:none}.num{min-width:1em;text-align:center}.current .num{background:var(--accent);color:var(--tg-theme-bg-color,light-dark(#fff,#172233))}
.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:.92em}
time{white-space:nowrap}.arrow{color:var(--muted)}details[open] .arrow{transform:rotate(90deg)}
.info{padding:0 0 9px 35px;font-size:.84em;overflow-wrap:anywhere}.info p+p{margin-top:4px}
nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
button{border:0;border-radius:9px;background:var(--surface);color:var(--accent);font:inherit;padding:5px 12px;min-height:32px;cursor:pointer}button:disabled{color:var(--muted)}
[hidden]{display:none!important}@media(max-width:270px){summary{gap:5px}body{padding:12px 9px}time{font-size:.67em}}
@media(prefers-reduced-motion:reduce){#fill{transition:none}}
</style>`;

const script = `<script>
const find = id => document.getElementById(id);
const pages = Array.from(document.querySelectorAll(".page"));
const lessons = Array.from(document.querySelectorAll("details"));
const timed = lessons.filter(row => row.dataset.start);
const back = find("back"), next = find("next"), count = find("count");
function show(index) {
  pages.forEach((page, i) => { page.hidden = index !== i; });
  lessons.forEach(row => { row.open = false; });
  if (!back) return;
  back.disabled = index === 0;
  next.disabled = index === pages.length - 1;
  count.textContent = (index + 1) + " / " + pages.length;
}
let page = 0;
if (back) {
  back.addEventListener("click", () => show(--page));
  next.addEventListener("click", () => show(++page));
}
lessons.forEach(row => row.addEventListener("toggle", () => {
  if (row.open) lessons.forEach(other => { if (other !== row) other.open = false; });
}));
function update() {
  const now = Date.now();
  const active = timed.find(row => now >= +row.dataset.start && now < +row.dataset.end);
  lessons.forEach(row => row.classList.toggle("current", row === active));
  const live = find("live");
  live.hidden = !active;
  if (!active) return;
  const start = +active.dataset.start, end = +active.dataset.end;
  const minutes = Math.ceil((end - now) / 60000);
  find("left").textContent = live.dataset.left.replace("{n}", minutes);
  find("fill").style.width = (100 * (now - start) / (end - start)) + "%";
}
const now = Date.now();
const first = timed.find(row => now < +row.dataset.end);
if (first && now >= +timed[0].dataset.start) page = Math.floor(lessons.indexOf(first) / ${pageSize});
show(page);
update();
let timer;
function start() { update(); clearInterval(timer); timer = setInterval(update, 5000); }
const widget = window.TelegramWidget;
if (widget) {
  widget.onEvent("activated", start);
  widget.onEvent("deactivated", () => clearInterval(timer));
  if (widget.isActive) start();
  widget.ready();
} else start();
</script>`;

export function buildScheduleWidget(schedule, user) {
  const en = user.language === "en";
  const w = t(user);
  const label = en ? schedule.date : dateTitle(schedule.date);
  const events = scheduleViewTimeline(schedule).filter(event => ["lesson", "curator_hour", "information_hour"].includes(event.type));
  const rows = events.map(event => {
    const variants = event.variants ?? [];
    const title = variants.map(variant => variant.subject).filter((subject, i, all) => all.indexOf(subject) === i).join(" / ") || w[event.type] || w.lesson;
    const room = variants.map(variant => variant.room).filter(Boolean);
    const details = variants.slice(0, 2).map(variant =>
      `<p>${short(variant.subject, 85)}<br><span class="muted">${short([variant.room && w.room + " " + variant.room, variant.teacher].filter(Boolean).join(" · "), 88)}</span></p>`);
    const notes = (event.notes ?? []).map(note => note.text);
    if (notes.length) details.push(`<p>${short(notes[0], 95)}</p>`);
    if (variants.length > 2 || notes.length > 1) details.push(`<p class="muted">${en ? "Full details in the text timetable" : "Все детали в обычном расписании"}</p>`);
    const start = Date.parse(`${schedule.date}T${event.start}:00+03:00`);
    const end = Date.parse(`${schedule.date}T${event.end}:00+03:00`);
    const window = Number.isFinite(start) && end > start ? ` data-start="${start}" data-end="${end}"` : "";
    const time = `${short(event.start, 5)}–${short(event.end, 5)}`;
    const meta = `<span class="name">${short(title, 115)}</span><time>${time}</time>`;
    const number = `<span class="num">${short(event.number ?? "·", 4)}</span>`;
    return {
      html: `<details${window}><summary>${number}${meta}<span class="arrow">›</span></summary><div class="info">${details.join("") || time}</div></details>`,
      caption: `${event.start ?? ""} ${title}${room.length ? " · " + [...new Set(room)].join("/") : ""}`,
    };
  });
  const notices = [...(schedule.statuses ?? []), ...(schedule.notes ?? [])].map(note => note.text);
  const empty = notices[0] ?? (en ? "No classes in the published timetable" : "В опубликованном расписании занятий нет");
  const pages = [];
  for (let i = 0; i < rows.length; i += pageSize) pages.push(`<section class="page"${i ? " hidden" : ""}>${rows.slice(i, i + pageSize).map(row => row.html).join("")}</section>`);
  if (!pages.length) pages.push(`<section class="page"><p>${short(empty, 210)}</p></section>`);
  const nav = pages.length > 1 ? `<nav><button id="back" disabled>‹</button><small id="count">1 / ${pages.length}</small><button id="next">›</button></nav>` : "";
  const heading = en ? "Timetable" : "Расписание";
  const html = `${style}<header><div><small>${escapeHtml(label)}</small><h1>${heading}</h1></div><span class="tag">${short(schedule.displayGroup, 30)}</span></header>
<section class="live" id="live" data-left="${en ? "{n} min left" : "Осталось {n} мин"}" hidden><p><span>${en ? "In progress" : "Идёт занятие"}</span><span id="left"></span></p><div class="track"><div id="fill"></div></div></section>
${pages.join("")}${nav}${rows.length && notices.length ? `<p class="muted">${short(notices[0], 110)}</p>` : ""}${script}`;
  const caption = [`${schedule.displayGroup} · ${label}`, ...rows.map(row => row.caption), ...(rows.length ? notices : [empty])].join("\n").replaceAll("\0", "");
  return { html, caption: caption.length > 1024 ? caption.slice(0, 1023).replace(/[\uD800-\uDBFF]$/u, "") + "…" : caption };
}
