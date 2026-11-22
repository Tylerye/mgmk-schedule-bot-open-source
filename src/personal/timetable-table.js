import { button } from "./view.js";

export function publishedDayButtons(schedules, date, user, branded) {
  const en = user.language === "en";
  const dates = [...new Set(schedules.map(item => item.date))].sort();
  const index = dates.indexOf(date);
  const buttons = [];
  if (index > 0) buttons.push(button(en ? "Earlier" : "Раньше", "preview:" + dates[index - 1] + ":full", { branded, icon: "back" }));
  if (index + 1 < dates.length) buttons.push(button(en ? "Later" : "Дальше", "preview:" + dates[index + 1] + ":compact", { branded, icon: "next" }));
  return buttons;
}
