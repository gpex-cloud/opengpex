import numpy as np
import tifffile

def generate_standard_linear_dng(out_path):
    width, height = 512, 512

    # 1. 构造 16-bit Full Raw 数据 (SubIFD 0)
    raw_img = np.zeros((height, width, 3), dtype=np.uint16)
    # 左上: 100% 纯白 (65535)
    raw_img[0:height//2, 0:width//2, :] = 65535
    # 右上: 75% 高亮灰 (49151)
    raw_img[0:height//2, width//2:width, :] = 49151
    # 左下: 50% 中灰 (32768)
    raw_img[height//2:height, 0:width//2, :] = 32768
    # 右下: 25% 暗灰 (16384)
    raw_img[height//2:height, width//2:width, :] = 16384
    # 中心 128x128: 18% 摄影标准中性灰 (11796)
    c_y1, c_y2 = height//2 - 64, height//2 + 64
    c_x1, c_x2 = width//2 - 64, width//2 + 64
    raw_img[c_y1:c_y2, c_x1:c_x2, :] = 11796

    # 2. 构造 8-bit Preview 预览图 (IFD0, 供 macOS 预览/QuickLook 快速无错渲染)
    preview_img = np.zeros((height, width, 3), dtype=np.uint8)
    preview_img[0:height//2, 0:width//2, :] = 255
    preview_img[0:height//2, width//2:width, :] = 191
    preview_img[height//2:height, 0:width//2, :] = 128
    preview_img[height//2:height, width//2:width, :] = 64
    preview_img[c_y1:c_y2, c_x1:c_x2, :] = 46

    # DNG 规范标签 (Adobe DNG Specification 1.4)
    # ColorMatrix1: XYZ(D65) -> Display-P3 (D65)
    cm1_vals = [
        24935, 10000, -9314, 10000, -4027, 10000,
        -8295, 10000, 17627, 10000, 236, 10000,
        358, 10000, -762, 10000, 9569, 10000
    ]
    asn_vals = [1, 1, 1, 1, 1, 1] # AsShotNeutral = [1.0, 1.0, 1.0]

    # IFD0 专属标签 (包含相机色彩配置文件与预览指示)
    ifd0_tags = [
        (50706, 1, 4, [1, 4, 0, 0], True),                     # DNGVersion = 1.4.0.0
        (50707, 1, 4, [1, 1, 0, 0], True),                     # DNGBackwardVersion = 1.1.0.0
        (50708, 2, 0, "OpenGPEX D65 Calibration Standard", True), # UniqueCameraModel
        (50778, 3, 1, [21], True),                             # CalibrationIlluminant1 = 21 (D65)
        (50721, 10, 9, cm1_vals, True),                        # ColorMatrix1 (SRATIONAL, 9)
        (50728, 5, 3, asn_vals, True),                         # AsShotNeutral (RATIONAL, 3)
        (50730, 10, 1, [0, 1], True),                          # BaselineExposure = 0.0
        (50936, 2, 0, "Display P3", True),                     # ProfileName = "Display P3"
    ]

    # SubIFD 0 专属标签 (全分辨率 16-bit 线性原始数据)
    subifd_tags = [
        (50714, 5, 1, [0, 1], True),                           # BlackLevel = 0
        (50717, 4, 1, [65535], True),                          # WhiteLevel = 65535
        (50719, 5, 2, [0, 1, 0, 1], True),                     # DefaultCropOrigin = [0, 0]
        (50720, 5, 2, [width, 1, height, 1], True),            # DefaultCropSize = [512, 512]
    ]

    # 写入规范的双层 IFD 结构
    with tifffile.TiffWriter(out_path) as tif:
        # Tier 1: IFD0 Preview 预览页
        tif.write(
            preview_img,
            subfiletype=1,      # FILETYPE.REDUCEDIMAGE (macOS / ACR 兼容必备)
            photometric='rgb',
            subifds=1,          # 声明指向 SubIFD 0
            extratags=ifd0_tags
        )
        # Tier 2: SubIFD 0 核心高精度 Raw 真实数据
        tif.write(
            raw_img,
            subfiletype=0,      # FILETYPE.FULLIMAGE
            photometric=34892,  # LinearRaw 规范标识
            extratags=subifd_tags
        )

    print(f"✅ 成功生成 macOS 兼容的规范 DNG: {out_path}")

if __name__ == '__main__':
    generate_standard_linear_dng('opengpex_v2/samples/21_d65_white_patch_16bit.dng')
