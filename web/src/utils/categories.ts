/**
 * Library categories — shelves the reader names, independent of AniList status.
 *
 * The documents live here rather than in a page because both `SettingsPage` (which manages them) and
 * `LibraryPage` (which groups by them and files titles into them) need the same ones, and neither
 * owns the concept.
 */

/**
 * The server's "Default" category is **virtual**: `category(id: 0).mangas` counts every library manga
 * filed nowhere else, `manga.categories` never lists it, and
 * `updateMangaCategories(patch: { addToCategories: [0] })` silently no-ops — it returns the manga with
 * an empty category list and no error. So it is a shelf we derive from an empty membership list, and
 * never an id we send anywhere.
 */
export const DEFAULT_CATEGORY_ID = 0

export interface Category {
  id: number
  name: string
  order: number
  default: boolean
  mangas: { totalCount: number }
}

export const CATEGORIES_QUERY = `
  query Categories {
    categories {
      nodes {
        id
        name
        order
        default
        mangas { totalCount }
      }
    }
  }
`

export const CREATE_CATEGORY_MUTATION = `
  mutation CreateCategory($name: String!) {
    createCategory(input: { name: $name }) {
      category { id name order default }
    }
  }
`

export const RENAME_CATEGORY_MUTATION = `
  mutation RenameCategory($id: Int!, $name: String!) {
    updateCategory(input: { id: $id, patch: { name: $name } }) {
      category { id name }
    }
  }
`

export const DELETE_CATEGORY_MUTATION = `
  mutation DeleteCategory($id: Int!) {
    deleteCategory(input: { categoryId: $id }) {
      category { id }
    }
  }
`

// `position` is the `order` the category should end up at, and Default holds 0, so a real category
// never moves below 1. The payload is the whole list, already renumbered.
export const REORDER_CATEGORY_MUTATION = `
  mutation ReorderCategory($id: Int!, $position: Int!) {
    updateCategoryOrder(input: { id: $id, position: $position }) {
      categories { id name order }
    }
  }
`

export const FILE_MANGAS_MUTATION = `
  mutation FileMangas($ids: [Int!]!, $add: [Int!], $remove: [Int!]) {
    updateMangasCategories(input: { ids: $ids, patch: { addToCategories: $add, removeFromCategories: $remove } }) {
      mangas { id categories { nodes { id } } }
    }
  }
`

export interface CategoriesResult {
  categories: { nodes: Category[] }
}

/** In the order the server keeps them, with Default dropped — it is never an editable row. */
export function sortedCategories(result: CategoriesResult | undefined): Category[] {
  return [...(result?.categories.nodes ?? [])]
    .filter((category) => category.id !== DEFAULT_CATEGORY_ID)
    .sort((a, b) => a.order - b.order || a.id - b.id)
}
