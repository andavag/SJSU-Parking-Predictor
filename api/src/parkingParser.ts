import * as cheerio from "cheerio";

import type { GarageId, GarageStatus, ShuttleLinks } from "./types.js";

export const SOURCE_URL = "https://sjsuparkingstatus.sjsu.edu/GarageStatusPlain";

export const GARAGES: Array<{ id: GarageId; name: string; address: string }> = [
  { id: "north", name: "North Garage", address: "65 S. 10th St., San Jose, CA 95112" },
  { id: "west", name: "West Garage", address: "350 S. 4th St., San Jose, CA 95112" },
  { id: "south", name: "South Garage", address: "377 S. 7th St., San Jose, CA 95112" },
  { id: "south-campus", name: "South Campus Garage", address: "1278 S. 10th Street, San Jose, CA 95112" }
];

const DEFAULT_SHUTTLE_DESCRIPTION = "During Fall and Spring semesters, parking shuttles run regularly from parking lots to campus.";
const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function absoluteUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, SOURCE_URL).toString();
  } catch {
    return undefined;
  }
}

function extractShuttleLinks($: cheerio.CheerioAPI, pageText: string): ShuttleLinks {
  const links: ShuttleLinks = { description: DEFAULT_SHUTTLE_DESCRIPTION };
  $("a").each((_, element) => {
    const label = compact($(element).text()).toLowerCase();
    const href = absoluteUrl($(element).attr("href"));
    if (label.includes("realtime shuttle location")) links.realtimeLocationUrl = href;
    if (label.includes("sjsu shuttle information")) links.informationUrl = href;
  });

  const descriptionMatch = pageText.match(/Parking Shuttles\s+(.+?)\s+(?:Realtime Shuttle Location|SJSU Shuttle Information)/i);
  if (descriptionMatch?.[1]) links.description = compact(descriptionMatch[1]);
  return links;
}

export interface ParsedParkingPage {
  sourceUpdatedAt: string;
  garages: GarageStatus[];
  shuttles: ShuttleLinks;
}

export function parseParkingPage(html: string): ParsedParkingPage {
  const $ = cheerio.load(html);
  const pageText = compact($("body").text());
  const updatedMatch = pageText.match(/Last updated\s+(.+?)\s+Refresh/i);
  if (!updatedMatch?.[1]) throw new Error("The SJSU parking page did not contain a Last updated timestamp.");

  const garages = GARAGES.map((garage) => {
    const matcher = new RegExp(`${escapeRegExp(garage.name)}[\\s\\S]{0,280}?(?:(\\d{1,3})\\s*%|\\b(FULL)\\b)`, "i");
    const match = pageText.match(matcher);
    if (!match) throw new Error(`The SJSU parking page did not contain status for ${garage.name}.`);

    const isFull = Boolean(match[2]);
    const fullnessPercent = isFull ? 100 : Number(match[1]);
    if (!Number.isInteger(fullnessPercent) || fullnessPercent < 0 || fullnessPercent > 100) {
      throw new Error(`The fullness percentage for ${garage.name} was invalid.`);
    }
    return { ...garage, fullnessPercent, isFull };
  });

  return { sourceUpdatedAt: compact(updatedMatch[1]), garages, shuttles: extractShuttleLinks($, pageText) };
}
