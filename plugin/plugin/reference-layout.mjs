import { renderArticle } from '../src/pipeline.mjs';

const cloneConfig = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const copyManaged = (entries = []) => entries.map((entry) => Object.freeze({ ...entry }));

/** Copy HTML has a responsive root: keep reference text at its design size. */
export function referenceCopyLayoutWidth(render, fallbackWidth) {
  const width = render?.referenceLayoutSource?.renderInput?.referenceComposition?.designWidth;
  if(Number.isInteger(width) && width >= 240 && width <= 1000)return width;
  const quoteSource=render?.quoteImageSource;
  if(quoteSource?.quoteImages?.illustration?.layout==='image'){
    // Composite images have fixed pixel geometry. Reflow at the current phone
    // preview width instead of silently changing it to the minimum (320px).
    const previewWidth=quoteSource.layoutWidth;
    return Number.isInteger(previewWidth)&&previewWidth>=320&&previewWidth<=430?previewWidth:390;
  }
  return fallbackWidth;
}

/** Freeze the source and resolved image identities, never call a live resolver on replay. */
export function createReferenceLayoutSource({ renderInput, rendered, materializeInput }) {
  if (!renderInput.referenceComposition) return null;
  const { resolve: _resolve, ...input } = renderInput;
  const renderSnapshot = {
    ...input,
    themeComponents: copyManaged(input.themeComponents),
    themeAssets: copyManaged(input.themeAssets),
    referenceComposition: cloneConfig(input.referenceComposition),
    themeHeader: cloneConfig(input.themeHeader),
    themeDarkMode: cloneConfig(input.themeDarkMode),
    orderedListImages: cloneConfig(input.orderedListImages),
    headerSelection: cloneConfig(input.headerSelection),
  };
  const typography = {
    ...materializeInput,
    headingImages: cloneConfig(materializeInput.headingImages),
    quoteImages: cloneConfig(materializeInput.quoteImages),
    orderedListImages: cloneConfig(materializeInput.orderedListImages),
    fonts: copyManaged(materializeInput.fonts),
    assets: copyManaged(materializeInput.assets),
    referenceComposition: cloneConfig(input.referenceComposition),
  };
  return Object.freeze({
    renderInput: Object.freeze(renderSnapshot),
    materializeInput: Object.freeze(typography),
    resolutions: Object.freeze((rendered.referenceResolvedImages ?? []).map(([target, value]) =>
      Object.freeze([target, value && typeof value === 'object' ? Object.freeze({ ...value }) : value]))),
  });
}

export async function replayReferenceLayout({ source, layoutWidth, materialize }) {
  const resolutions = new Map(source.resolutions);
  const rendered = renderArticle({
    ...source.renderInput,
    layoutWidth,
    resolve: (target) => resolutions.get(target) ?? null,
  });
  const output = await materialize({
    ...source.materializeInput,
    layoutWidth,
    html: rendered.html,
    images: rendered.images,
  });
  return { html: output.html, images: output.images, imageWarnings: [...rendered.warnings, ...output.warnings] };
}
