## Partie 1 – Revue de code et correction de bugs

### Extrait A

| Problème | Gravité | Correction proposée |
|----------|---------|---------------------|
| `useEffect` n'a pas de tableau de dépendances alors l'effet s'exécute après chaque rendu. setListings déclenche un rendu, qui relance le fetch ce qui peut provoquer une boucle infinie de requêtes. | Elevée | Ajout d'un tableau de dépendances avec la valeur `[city]` sur le useEffect afin d'éxécuter qu'un seul appel par changement de la valeur city. |
| `Aucune gestion d'erreurs` : il ne vérifie jamais si la réponse est valide (r.ok) et il n'y a pas de .catch. Par conséquent, si le réseau tombe, loading reste à true et l'utilisateur voit un chargement sans fin. Si le serveur renvoie une erreur 500, data contient un message d'erreur au lieu d'une liste, donc listings.map plante et affichera une page blanche.| Élevée | Vérification du `r.ok`, ajout d'une gestion d'erreur `.catch`, mettre `setLoading` dans un final qui s'executera toujours malgré la réponse du fetch. |
| Si city change vite par exemple si l'utilisateur clique sur plusieurs villes d'affilés, plusieurs fetch partent en même temps, une réponse plus ancienne peut arriver en dernier et afficher les annonces de la mauvaise ville. | Élevée | `AbortController` annulé dans la fonction de nettoyage de l'effet. |
| `city` non encodé dans l'URL : une ville avec &, #, espace ou accent casse ou détourne la requête ; city absent envoie city=undefined. | Moyenne | `encodeURIComponent(city)` et ne pas appeler l'API sans ville. |
| `<li>` sans `key` : avertissement React et réconciliation incorrecte quand la liste change. | Moyenne | Ajout d'un key sur li. |
| `l.price.toLocaleString()` plante si price est null. | Moyenne | Mettre la valeur par défaut à 0 si le prix est null |

Correction de l'extrzit A 

```jsx
import { useEffect, useState } from "react";

export function ListingList({ city }) {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(false); 

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetch(`/api/listings?city=${encodeURIComponent(city)}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Erreur :  ${r.status}`);
        return r.json();
      })
      .then((data) => setListings(data))
      .catch((err) => {
        if (err.name !== "AbortError") setStatus("error");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();

  }, [city]);

  if (status === "loading") return <p>Chargement…</p>;

  return (
    <ul>
      {listings.map((l) => (
        <li key={l.id}>
          {l.title} – {typeof l.price === "number" ? `${priceFormatter.format(l.price)} Ar` : "Prix sur demande"}
        </li>
      ))}
    </ul>
  );
}
```

### Extrait B

| Problème | Gravité | Correction proposée |
|----------|---------|---------------------|
| **Injection SQL** : `city` est concaténé dans la requête. `?city=' OR '1'='1` renvoie toute les données du table ; une charge plus élaborée peut lire d'autres tables | Elevée | Utilisation d'une requête paramétrée `WHERE city = $1` et une validation du paramètre. |
| **N+1 requêtes séquentielles** : pour N annonces, 1 + 2N requêtes attendues l'une après l'autre. Pour 300 annonces : 601 requêtes par appel. Sous un pic de trafic, le pool de connexions est saturé et toute l'API ralentit. | Elevée | Ne faire que 3 requêtes au total : les annonces de la page, puis agences et photos en lot avec `= ANY($1)`, en parallèle. |
| **Pas de pagination** : `page` est lu mais ignoré, la route renvoie toutes les annonces de la ville. Réponses de plusieurs Mo, temps de requête qui augmente avec le catalogue. | Élevée | `LIMIT` / `OFFSET` avec taille de page fixe, `page` validé et borné, `hasMore` calculé en demandant une ligne de plus. |
| **Aucune gestion d'erreur** : un rejet dans un handler `async` n'est pas capturé. La requête reste sans réponse jusqu'au timeout, les connexions s'accumulent, et selon la version de Node le process peut s'arrêter. | Élevée | Ajout du gestion d'erreur `try/catch` + `next(err)`. |


### Extrait C

| Problème | Gravité | Correction proposée |
|----------|---------|---------------------|
| **Aucune vérification de signature** : n'importe qui peut envoyer `{"type":"payment.succeeded","booking_id":123}` et obtenir une réservation payée sans payer. | Elevée | Vérifier la signature HMAC du prestataire sur le corps brut, comparaison à temps constant, refus des horodatages trop anciens. |
| **Traitement lent avant la réponse** : email + CRM (2 à 8 s) sont attendus avant le `200`. Au-delà de 10 s, le prestataire considère l'appel en échec et réessaie, alors que la base est déjà à jour. | Élevée | Répondre `200` dès l'enregistrement en base ; email et CRM passent par une table outbox traitée par un worker . |
| **Pas d'idempotence** : chaque réessai du prestataire jusqu'à 5 renvoie l'email et renotifie le CRM. | Élevée | Table `processed_webhook_events` avec `event_id` en clé primaire `ON CONFLICT DO NOTHING`, transition autorisée uniquement depuis `pending`. |
| **Pas de gestion d'erreur ni de transaction** : si l'email ou le CRM échoue, le handler rejette sans répondre, le prestataire réessaie, et l'étape qui avait réussi est refaite (paiement mis à jour, email parfois envoyé deux fois). | Élevée | Mise à jour + événement + outbox dans une seule transaction ; en cas d'erreur, `ROLLBACK` et `500` volontaire pour obtenir un réessai propre. |

---