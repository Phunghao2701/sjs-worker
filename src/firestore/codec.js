const fieldsToObject = (fields = {}) => Object.fromEntries(
  Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]),
);

export function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (value && typeof value === 'object' && value.__firestoreVector === true) {
    return { vectorValue: { values: value.values.map(Number) } };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'bigint') return { integerValue: value.toString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError(`Unsupported Firestore value: ${typeof value}`);
}

export function encodeFields(data) {
  const result = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) result[key] = encodeValue(value);
  }
  return result;
}

export function decodeValue(value = {}) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) {
    const number = Number(value.integerValue);
    return Number.isSafeInteger(number) ? number : value.integerValue;
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return fieldsToObject(value.mapValue.fields);
  if ('vectorValue' in value) return value.vectorValue.values || [];
  return null;
}

export const vectorValue = (values) => ({ __firestoreVector: true, values });

export function decodeDocument(document) {
  if (!document) return null;
  const name = document.name || '';
  const id = name.split('/').at(-1);
  return { id, ...fieldsToObject(document.fields) };
}
