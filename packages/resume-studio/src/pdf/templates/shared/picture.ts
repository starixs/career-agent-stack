import type { ResumeData } from "../../../schema/resume/data";

export const hasTemplatePicture = (picture: ResumeData["picture"]) => !picture.hidden && picture.url.trim() !== "";
