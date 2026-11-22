import json
import re
import sys

import xlrd

WEEKDAYS = dict(zip(
    "ПОНЕДЕЛЬНИК ВТОРНИК СРЕДА ЧЕТВЕРГ ПЯТНИЦА СУББОТА ВОСКРЕСЕНЬЕ".split(),
    "monday tuesday wednesday thursday friday saturday sunday".split(),
))
HOURS = {"КУРАТОРСКИЙ ЧАС": "curator_hour", "ИНФОРМАЦИОННЫЙ ЧАС": "information_hour"}


def clean(value, separator=" "):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return separator.join(" ".join(line.split()) for line in str(value).splitlines() if line.strip())


def read_workbook(path):
    book = xlrd.open_workbook(path, on_demand=True, formatting_info=True)
    sheet = book.sheet_by_index(0)
    if sheet.nrows > 200 or sheet.ncols > 60:
        raise ValueError("Weekly worksheet exceeds its expected dimensions")
    rows = [sheet.row_values(i) for i in range(sheet.nrows)]
    header = next(i for i, row in enumerate(rows) if any(clean(v).lower() == "каб" for v in row))
    columns = [i for i in range(1, sheet.ncols - 1)
               if clean(rows[header][i]) and clean(rows[header][i + 1]).lower() == "каб"]
    if not columns or any(not re.fullmatch(r"\d{1,3}[^\W\d_]{1,6}", re.sub(r"[\s-]", "", clean(rows[header][i])))
                          for i in columns):
        raise ValueError("Unrecognized weekly group header")
    groups = [{"label": clean(rows[header][i]), "days": {}} for i in columns]
    day = None
    saw_footer = False
    for row_index, row in enumerate(rows[header + 1:], header + 1):
        if any(re.match(r"Зам\s*\.\s*директора", clean(value), re.I) for value in row):
            saw_footer = True
            break
        first = clean(row[0]).upper()
        if first in WEEKDAYS:
            day = WEEKDAYS[first]
            for group in groups:
                group["days"][day] = {"lessons": [], "hours": []}
            continue
        if not day:
            continue
        for col, group in zip(columns, groups):
            subject = clean(row[col], " / ")
            hour = HOURS.get(subject.upper())
            if not subject and not first:
                merged = next((c0 for r0, r1, c0, c1 in sheet.merged_cells
                               if r0 == row_index < r1 and c0 <= col < c1), None)
                if merged is not None:
                    hour = HOURS.get(clean(row[merged]).upper())
            entry = group["days"][day]
            if hour:
                entry["hours"].append(hour)
            elif subject and first.isdecimal():
                entry["lessons"].append([int(first), subject, clean(row[col + 1], " / ")])
            elif subject:
                raise ValueError(f"Unrecognized weekly entry at row {row_index + 1}")
    if not saw_footer or not all(key in groups[0]["days"] for key in ("monday", "saturday")):
        raise ValueError("Incomplete weekly worksheet")
    return groups


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump([group for path in sys.argv[1:] for group in read_workbook(path)], sys.stdout, ensure_ascii=False)
