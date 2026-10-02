---
name: images
description: Embedding images in Remotion using the  component
metadata:
  tags: images, img, staticFile, png, jpg, svg, webp
---

# Using images in Remotion

## The `` component

Always use the `` component from `remotion` to display images:

```tsx
import { Img, staticFile } from "remotion";

export const MyComposition = () => {
  return ;
};
```

## Important restrictions

**You MUST use the `` component from `remotion`.** Do not use:

- Native HTML `` elements
- Next.js `<Image>` component
- CSS `background-image`

The `` component ensures images are fully loaded before rendering, preventing flickering and blank frames during video export.

## Local images with staticFile()

Place images in the `public/` folder and use `staticFile()` to reference them:

```
my-video/
├─ public/
│  ├─ logo.png
│  ├─ avatar.jpg
│  └─ icon.svg
├─ src/
├─ package.json
```

```tsx
import { Img, staticFile } from "remotion";
```

## Remote images

Remote URLs can be used directly without `staticFile()`:

```tsx
```

Ensure remote images have CORS enabled.

For animated GIFs, use the `<Gif>` component from `@remotion/gif` instead.

## Sizing and positioning

Use the `style` prop to control size and position:

```tsx
```

## Dynamic image paths

Use template literals for dynamic file references:

```tsx
import { Img, staticFile, useCurrentFrame } from "remotion";

const frame = useCurrentFrame();

// Image sequence

// Selecting based on props

// Conditional images
```

This pattern is useful for:

- Image sequences (frame-by-frame animations)
- User-specific avatars or profile images
- Theme-based icons
- State-dependent graphics

## Getting image dimensions

Use `getImageDimensions()` to get the dimensions of an image:

```tsx
import { getImageDimensions, staticFile } from "remotion";

const { width, height } = await getImageDimensions(staticFile("photo.png"));
```

This is useful for calculating aspect ratios or sizing compositions:

```tsx
import { getImageDimensions, staticFile, CalculateMetadataFunction } from "remotion";

const calculateMetadata: CalculateMetadataFunction = async () => {
  const { width, height } = await getImageDimensions(staticFile("photo.png"));
  return {
    width,
    height,
  };
};
```
