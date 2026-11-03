// 经典模板的 HTML 版注册表：每套一个文件，值为 null 的仍走 react-pdf（迁移期）。
import type { Template } from "../../schema/templates";
import type { HtmlTemplate } from "../templates";
import { azurill } from "./azurill";
import { bronzor } from "./bronzor";
import { chikorita } from "./chikorita";
import { ditgar } from "./ditgar";
import { ditto } from "./ditto";
import { gengar } from "./gengar";
import { glalie } from "./glalie";
import { kakuna } from "./kakuna";
import { lapras } from "./lapras";
import { leafish } from "./leafish";
import { meowth } from "./meowth";
import { onyx } from "./onyx";
import { pikachu } from "./pikachu";
import { rhyhorn } from "./rhyhorn";
import { scizor } from "./scizor";

export const CLASSIC_HTML_TEMPLATES: Partial<Record<Template, HtmlTemplate | null>> = {
	azurill, bronzor, chikorita, ditgar, ditto, gengar, glalie, kakuna, lapras, leafish, meowth, onyx, pikachu, rhyhorn, scizor,
};
