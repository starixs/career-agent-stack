import z from "zod";
import { BRAND_TEMPLATES } from "../pdf/templates/brand/brands";

export { BRAND_STYLES, BRAND_TEMPLATES, isBrandTemplate } from "../pdf/templates/brand/brands";
export type { BrandTemplate } from "../pdf/templates/brand/brands";

export const templateSchema = z.enum([
	"azurill",
	"bronzor",
	"chikorita",
	"ditgar",
	"ditto",
	"gengar",
	"glalie",
	"kakuna",
	"lapras",
	"leafish",
	"meowth",
	"onyx",
	"pikachu",
	"rhyhorn",
	"scizor",
	...BRAND_TEMPLATES,
]);

export type Template = z.infer<typeof templateSchema>;
