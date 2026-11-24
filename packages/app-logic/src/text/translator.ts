/**
 * THE CATALOGUE'S READER AS BEHAVIOUR SEES IT: a key and its values in, the sentence out. The web
 * shell's text package hands a wider one; behaviour asks for this call and nothing more of it.
 */
export type TranslationValue = string | number | boolean | Date | null | undefined;
export type Translator = (key: string, values?: Record<string, TranslationValue>) => string;
