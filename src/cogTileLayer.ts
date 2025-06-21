import { TileLayer, TileLayerProps } from "@deck.gl/geo-layers";
import type {
  Tile2DHeader,
  TileLoadProps,
} from "@deck.gl/geo-layers/dist/tileset-2d";
import { BitmapLayer } from "@deck.gl/layers";
import { TILE_SIZE } from "./constants";
import CogReader from "./read/cogReader";
import { tileIndexToMercatorBbox } from "./read/math";
import CustomRendererStore from "./render/custom/rendererStore";
import renderPhoto from "./render/renderPhoto";
import { Bbox, TypedArray } from "./types";

export interface CogTileLayerProps
  extends Omit<TileLayerProps<ImageBitmap>, "data"> {
  url: string;
  coverageBox?: boolean;
}

export class CogTileLayer extends TileLayer<ImageBitmap> {
  static layerName = "CogTileLayer";
  private cogReader: CogReader;
  readonly url: string;
  readonly coverageBox: boolean;

  constructor(props: CogTileLayerProps) {
    super(props);
    this.url = props.url;
    this.coverageBox = props.coverageBox || false;
    this.cogReader = new CogReader(this.url);
  }

  async getTileData(tile: TileLoadProps): Promise<ImageBitmap> {
    const { x, y, z } = tile.index;
    try {
      let rgba: Uint8ClampedArray;
      const metadata = await this.cogReader.getMetadata();
      if (this.coverageBox && z < metadata.minOverview - 1) {
        const coverage = this.generateCoverageTile(
          x,
          y,
          z,
          metadata.webMercatorBbox,
          TILE_SIZE
        );
        rgba = renderPhoto(coverage, metadata);
      } else {
        const rawTile = await this.cogReader.getRawTile({ z, x, y });
        const renderCustom = CustomRendererStore.get(this.url);
        rgba =
          renderCustom !== undefined
            ? renderCustom(rawTile, metadata)
            : renderPhoto(rawTile, metadata);
      }
      return await createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE));
    } catch (error) {
      console.error(`Error loading COG tile ${x}/${y}/${z}:`, error);
      return this.createErrorTile(x, y, z); // TODO try and only error the data bounds?
    }
  }

  renderSubLayers(
    props: TileLayer["props"] & {
      id: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: any;
      _offset: number;
      tile: Tile2DHeader;
    }
  ): BitmapLayer {
    const { boundingBox } = props.tile;
    const west = boundingBox[0][0];
    const south = boundingBox[0][1];
    const east = boundingBox[1][0];
    const north = boundingBox[1][1];

    return new BitmapLayer(props, {
      data: undefined,
      image: props.data,
      bounds: [west, south, east, north],
    });
  }

  private createErrorTile(
    x: number,
    y: number,
    z: number
  ): Promise<ImageBitmap> {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#FF00FF";
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);

    ctx.fillStyle = "white";
    ctx.font = "12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const centerX = TILE_SIZE / 2;
    const centerY = TILE_SIZE / 2;

    ctx.fillText("Error loading", centerX, centerY - 10);
    ctx.fillText("COG tile", centerX, centerY + 5);
    ctx.fillText(`${z}/${x}/${y}`, centerX, centerY + 20);

    return createImageBitmap(canvas);
  }

  private generateCoverageTile = (
    tileX: number,
    tileY: number,
    tileZ: number,
    rasterBbox: Bbox,
    tileSize: number = 256
  ): TypedArray => {
    const tileBbox = tileIndexToMercatorBbox({ x: tileX, y: tileY, z: tileZ });
    const [tileWest, tileSouth, tileEast, tileNorth] = tileBbox;
    const [rasterWest, rasterSouth, rasterEast, rasterNorth] = rasterBbox;

    const pixelWest = Math.max(
      0,
      Math.floor(
        ((Math.max(rasterWest, tileWest) - tileWest) / (tileEast - tileWest)) *
          tileSize
      )
    );
    const pixelEast = Math.min(
      tileSize - 1,
      Math.floor(
        ((Math.min(rasterEast, tileEast) - tileWest) / (tileEast - tileWest)) *
          tileSize
      )
    );
    const pixelNorth = Math.max(
      0,
      Math.floor(
        ((tileNorth - Math.min(rasterNorth, tileNorth)) /
          (tileNorth - tileSouth)) *
          tileSize
      )
    );
    const pixelSouth = Math.min(
      tileSize - 1,
      Math.floor(
        ((tileNorth - Math.max(rasterSouth, tileSouth)) /
          (tileNorth - tileSouth)) *
          tileSize
      )
    );

    const tile = new Uint8Array(tileSize * tileSize * 3);
    for (let y = pixelNorth; y <= pixelSouth; y++) {
      for (let x = pixelWest; x <= pixelEast; x++) {
        if (x >= 0 && x < tileSize && y >= 0 && y < tileSize) {
          const index = (y * tileSize + x) * 3;
          tile[index] = 1;
          tile[index + 1] = 1;
          tile[index + 2] = 1;
        }
      }
    }

    return tile as TypedArray;
  };
}
