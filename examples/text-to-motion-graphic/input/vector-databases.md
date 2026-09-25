# Vector databases in brief

Keyword search matches the words you typed. A search for "cheap flight" can miss a page that only says "low-cost airfare", because the two share no words.

An embedding model turns a piece of text into a vector: a list of numbers. Texts with similar meanings get vectors that sit close together.

A vector database stores those vectors in an index built for similarity. At query time it embeds the question and returns the nearest neighbours: the stored items whose vectors are closest to the query.

Most vector databases use approximate nearest-neighbour (ANN) indexes such as HNSW, which trade a little accuracy for much faster search over large collections.

The usual flow has four steps: embed your documents, store the vectors, embed the query, and ask for the top matches.
