import { fromUrl, GeoTIFF, Pool } from "geotiff";
import QuickLRU from "quick-lru";

import {
  Bbox,
  CogMetadata,
  ImageMetadata,
  TileIndex,
  TypedArray,
} from "../types";
import {
  mercatorBboxToGeographicBbox,
  tileIndexToMercatorBbox,
  zoomFromResolution,
} from "./math";

const ONE_HOUR_IN_MILLISECONDS = 60 * 60 * 1000;

export default class CogReader {
  pool: Pool;
  geoTiffCache: QuickLRU<string, Promise<GeoTIFF>>;
  metadataCache: QuickLRU<string, Promise<CogMetadata>>;
  tileCache: QuickLRU<string, Promise<TypedArray>>;
  constructor(readonly url: string) {
    this.pool = new Pool();
    this.geoTiffCache = new QuickLRU<string, Promise<GeoTIFF>>({
      maxSize: 16,
      maxAge: ONE_HOUR_IN_MILLISECONDS,
    });
    this.metadataCache = new QuickLRU<string, Promise<CogMetadata>>({
      maxSize: 16,
      maxAge: ONE_HOUR_IN_MILLISECONDS,
    });
    this.tileCache = new QuickLRU<string, Promise<TypedArray>>({
      maxSize: 1024,
      maxAge: ONE_HOUR_IN_MILLISECONDS,
    });
  }

  private async getGeoTiff(url: string): Promise<GeoTIFF> {
    const cachedGeoTiff = this.geoTiffCache.get(url);
    if (cachedGeoTiff) {
      return cachedGeoTiff;
    } else {
      const geoTiff = fromUrl(url);
      this.geoTiffCache.set(url, geoTiff);
      return geoTiff;
    }
  }

  async getMetadata(): Promise<CogMetadata> {
    const cachedMetadata = this.metadataCache.get(this.url);
    if (cachedMetadata) {
      return cachedMetadata;
    } else {
      const tiff = await this.getGeoTiff(this.url);
      const firstImage = await tiff.getImage();
      const gdalMetadata = firstImage.getGDALMetadata(0); // Metadata for first image and first sample
      const fileDirectory = firstImage.fileDirectory;
      const artist = firstImage.fileDirectory?.Artist;
      const bbox = mercatorBboxToGeographicBbox(
        firstImage.getBoundingBox() as Bbox
      );
      const webMercatorBbox = firstImage.getBoundingBox() as Bbox;
      const imagesMetadata: Array<ImageMetadata> = [];
      const imageCount = await tiff.getImageCount();
      const overviews: number[] = [];
      for (let index = 0; index < imageCount; index++) {
        const image = await tiff.getImage(index);
        const zoom = zoomFromResolution(image.getResolution(firstImage)[0]);
        const isOverview = !!(image.fileDirectory.NewSubfileType & 1);
        const isMask = !!(image.fileDirectory.NewSubfileType & 4);
        if (!isMask && isOverview) {
          overviews.push(zoom);
        }
        imagesMetadata.push({ zoom, isOverview, isMask });
      }

      const metadata = {
        offset:
          gdalMetadata?.OFFSET !== undefined
            ? parseFloat(gdalMetadata.OFFSET)
            : 0.0,
        scale:
          gdalMetadata?.SCALE !== undefined
            ? parseFloat(gdalMetadata.SCALE)
            : 1.0,
        noData: firstImage.getGDALNoData() ?? undefined,
        photometricInterpretation: fileDirectory?.PhotometricInterpretation,
        bitsPerSample: fileDirectory?.BitsPerSample,
        colorMap: fileDirectory?.ColorMap,
        artist: artist,
        bbox: bbox,
        webMercatorBbox,
        images: imagesMetadata,
        maxOverview: Math.max(...overviews),
        minOverview: Math.min(...overviews),
      };
      this.metadataCache.set(this.url, Promise.resolve(metadata));
      console.log(metadata);
      return metadata;
    }
  }

  async getRawTile(
    { z, x, y }: TileIndex,
    tileSize: number = 256
  ): Promise<TypedArray> {
    const tileKey = `${this.url}/${tileSize}/${z}/${x}/${y}`;
    const cachedTile = await this.tileCache.get(tileKey);
    if (cachedTile) {
      return cachedTile;
    } else {
      const tiff = await this.getGeoTiff(this.url);
      const { noData, minOverview } = await this.getMetadata();
      // if the tile is 2 levels below the minOverview, return empty data
      // to prevent invalid typed array length errors
      if (z < minOverview - 1) {
        return new Uint8Array(tileSize * tileSize * 3);
      }
      // FillValue won't accept NaN.
      // Infinity will work for Float32Array and Float64Array.
      // Int and Uint arrays will be filled with zeroes.
      const fillValue =
        noData === undefined || isNaN(noData) ? Infinity : noData;

      const mercator = tileIndexToMercatorBbox({ x, y, z });
      const tile = tiff.readRasters({
        bbox: mercator,
        width: tileSize,
        height: tileSize,
        interleave: true,
        resampleMethod: "nearest",
        pool: this.pool,
        fillValue, // When fillValue is Infinity, integer types will be filled with a 0 value.
      }) as Promise<TypedArray>; // ReadRasterResult extends TypedArray

      this.tileCache.set(tileKey, tile);
      return tile;
    }
  }
}
