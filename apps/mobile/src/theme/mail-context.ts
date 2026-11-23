import { createContext } from "react";
import type { Theme } from "./index";

export const MailThemeContext = createContext<Theme | null>(null);
