// JSON values: what Discogs and Genius send, what Obsidian keeps in data.json and workspace.json, and what
// it parses a note's frontmatter into. Input is read as these types where it enters the plugin, then
// narrowed with the guards below; nothing else looks inside a value it hasn't checked.

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject { readonly [key: string]: JsonValue | undefined }

const isJsonObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isJsonList = (v: JsonValue | undefined): v is JsonValue[] => Array.isArray(v);
const isText = (v: JsonValue | undefined): v is string => typeof v === "string";
// A finite number: JSON has no NaN or Infinity, but a hand-edited file or a stand-in might.
const isNumber = (v: JsonValue | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: JsonValue | undefined): v is boolean => typeof v === "boolean";

// A property of an object, or undefined when the value isn't an object or hasn't got it.
const field = (v: JsonValue | undefined, key: string): JsonValue | undefined => (isJsonObject(v) ? v[key] : undefined);
// A list's items, or none when the value isn't a list.
const items = (v: JsonValue | undefined): JsonValue[] => (isJsonList(v) ? v : []);
// A list's text items, the rest left out.
const texts = (v: JsonValue | undefined): string[] => items(v).filter(isText);
// An object's properties, or none when the value isn't an object.
const entries = (v: JsonValue | undefined): [string, JsonValue | undefined][] => (isJsonObject(v) ? Object.entries(v) : []);

export type { JsonValue, JsonObject };
export { isJsonObject, isJsonList, isText, isNumber, isBoolean, field, items, texts, entries };
