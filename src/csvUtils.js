function csvEscape(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const stringValue = String(value);

  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function csvFormatRow(values) {
  return values.map(csvEscape).join(",");
}

function csvFormatValue(value) {
  return csvEscape(value);
}

module.exports = {
  csvEscape,
  csvFormatRow,
  csvFormatValue,
};
