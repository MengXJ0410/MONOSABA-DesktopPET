/**
 * 角色头像资源。
 *
 * 新增头像：把图片放进 `public/avatars/<角色>/`，文件名按 02/03… 顺延，
 * 再追加到下面的列表即可；当前默认使用列表中的第一张。
 */

export const HIRO_AVATARS = ["/avatars/hiro/01.jpg"] as const;

export type HiroAvatar = (typeof HIRO_AVATARS)[number];

export const HIRO_AVATAR: HiroAvatar = HIRO_AVATARS[0];
